/**
 * Слой доступа к GraphQL API Senkuro (https://api.senkuro.com/graphql).
 *
 * API отдаёт все закладки пользователя курсорной пагинацией, поэтому скрипт
 * больше не зависит от динамической прокрутки страницы «Мои Закладки».
 *
 * Файл — обычный classic script (без сборщика): экспортирует globalThis.SenkuroApi.
 */
(function (root) {
    'use strict';

    const ENDPOINT = 'https://api.senkuro.com/graphql';
    const PAGE_SIZE = 100;
    const MAX_PAGES = 50;

    const VIEWER_QUERY = 'query viewer { viewer { user { id name } } }';

    const BOOKMARKS_QUERY = `query userBookmarks($userId: ID!, $first: Int!, $after: String) {
  userBookmarks(subjectType: MANGA, userId: $userId, first: $first, after: $after) {
    totalCount
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        status
        number
        createdAt
        updatedAt
        entity {
          ... on Manga {
            id
            slug
            type
            status
            isLicensed
            formats
            titles { lang content }
            originalName { lang content }
            cover { original { url } }
          }
        }
      }
    }
  }
}`;

    /** Статус закладки → вкладка в popup. */
    const USER_STATUS = {
        WATCHING: 'Читаю',
        PLANNING: 'В планах',
        COMPLETED: 'Прочитано'
    };

    /** Тип тайтла → подпись на карточке. */
    const TITLE_TYPE = {
        MANGA: 'Манга',
        MANHWA: 'Манхва',
        MANHUA: 'Маньхуа',
        COMICS: 'Комиксы'
    };

    /** Статус самого тайтла (не закладки). */
    const GLOBAL_STATUS = {
        ONGOING: 'Онгоинг',
        COMPLETED: 'Завершён',
        HIATUS: 'Приостановлен',
        CANCELLED: 'Отменён',
        DISCONTINUED: 'Завершён'
    };

    /** Русское название приоритетнее оригинала и альтернативных имён. */
    function pickTitle(manga) {
        const titles = Array.isArray(manga.titles) ? manga.titles : [];
        const ru = titles.find((item) => item && item.lang === 'RU' && item.content);
        if (ru) return ru.content;

        const original = manga.originalName && manga.originalName.content;
        if (original) return original;

        const first = titles.find((item) => item && item.content);
        return first ? first.content : manga.slug;
    }

    /** Приводит узел userBookmarks к записи, которую хранит расширение. */
    function normalizeBookmark(node) {
        if (!node) return null;

        const manga = node.entity;
        if (!manga || !manga.slug) return null;

        return {
            slug: manga.slug,
            title: pickTitle(manga),
            lastChapter: node.number === null || node.number === undefined ? '0' : String(node.number),
            isLicensed: Boolean(manga.isLicensed),
            userStatus: USER_STATUS[node.status] || 'Читаю',
            format: TITLE_TYPE[manga.type] || 'Манга',
            coverUrl: (manga.cover && manga.cover.original && manga.cover.original.url) || '',
            globalStatus: GLOBAL_STATUS[manga.status] || 'Онгоинг',
            date: node.updatedAt || node.createdAt || null
        };
    }

    /** Один GraphQL-запрос. token — access_token из сессии сайта. */
    async function request(query, variables, options) {
        const opts = options || {};
        const fetchImpl = opts.fetchImpl || root.fetch;
        const headers = {
            'Content-Type': 'application/json',
            Accept: 'application/json'
        };

        if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

        const response = await fetchImpl(ENDPOINT, {
            method: 'POST',
            credentials: 'include',
            headers,
            body: JSON.stringify({ query, variables })
        });

        if (!response.ok) {
            throw new Error(`Senkuro API: HTTP ${response.status}`);
        }

        const payload = await response.json();

        if (payload.errors && payload.errors.length) {
            throw new Error(`Senkuro API: ${payload.errors.map((item) => item.message).join('; ')}`);
        }

        if (!payload.data) {
            throw new Error('Senkuro API: пустой ответ');
        }

        return payload.data;
    }

    /**
     * access_token лежит в host-only куке для senkuro.com и не улетает на
     * api.senkuro.com автоматически. Достаём его из document.cookie, чтобы
     * передать как Authorization: Bearer.
     */
    function getAccessToken() {
        try {
            const cookie = root.document ? root.document.cookie : '';
            for (const part of cookie.split(';')) {
                const pair = part.trim();
                if (pair.startsWith('access_token=')) {
                    return decodeURIComponent(pair.slice('access_token='.length));
                }
            }
        } catch {
            // document.cookie недоступен — вернём null.
        }
        return null;
    }

    /** Извлекает userId из ответа viewer. */
    function extractUserId(data) {
        const viewer = data && data.viewer;
        return viewer && viewer.user && viewer.user.id ? viewer.user.id : null;
    }

    /**
     * Забирает все закладки пользователя (курсорная пагинация до конца).
     * Сначала пробует куки (credentials: 'include'), затем Authorization: Bearer
     * из document.cookie — закладки могут жить в host-only куке.
     * @returns {Promise<{data: Object, total: number, pages: number}>}
     */
    async function fetchBookmarks(options) {
        let userId = extractUserId(await request(VIEWER_QUERY, {}, options));

        if (!userId) {
            const token = getAccessToken();
            if (!token) {
                throw new Error('Senkuro: нет авторизации — войдите на сайте senkuro.com');
            }
            options = { ...options, token };
            userId = extractUserId(await request(VIEWER_QUERY, {}, options));
            if (!userId) {
                throw new Error('Senkuro: нет авторизации — войдите на сайте senkuro.com');
            }
        }

        const data = {};
        let after = null;
        let total = 0;
        let pages = 0;

        do {
            const result = await request(BOOKMARKS_QUERY, { userId, first: PAGE_SIZE, after }, options);
            const connection = result.userBookmarks;

            if (!connection) {
                throw new Error('Senkuro API: пустой список закладок');
            }

            total = connection.totalCount || 0;

            for (const edge of connection.edges || []) {
                const record = normalizeBookmark(edge.node);
                if (record) data[record.slug] = record;
            }

            const pageInfo = connection.pageInfo || {};
            after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
            pages += 1;
        } while (after && pages < MAX_PAGES);

        return { data, total, pages };
    }

    root.SenkuroApi = { ENDPOINT, fetchBookmarks, normalizeBookmark };
})(typeof globalThis !== 'undefined' ? globalThis : this);
