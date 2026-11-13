const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function isSenkuroUrl(url) {
    try {
        const hostname = new URL(url).hostname;
        return hostname === 'senkuro.com' || hostname === 'senkuro.me';
    } catch {
        return false;
    }
}

const FALLBACK_COVER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='102'%3E%3Crect width='100%25' height='100%25' fill='%2345475a'/%3E%3C/svg%3E";

function safeCoverUrl(url) {
    if (!url) return FALLBACK_COVER;

    try {
        const parsed = new URL(url, 'https://senkuro.com');
        if (parsed.protocol === 'https:') return parsed.href;
    } catch {
        // Некорректный URL — используем заглушку.
    }

    return FALLBACK_COVER;
}

document.addEventListener('DOMContentLoaded', () => {
    let allTitlesArray = [];
    let currentTab = 'Читаю';
    let currentPage = 1;
    const itemsPerPage = 9;

    let globalHashMap = {};
    let pendingSyncData = null;

    let farmPollInterval = null;
    let lastTasks = [];

    // Базовый сайт для ссылок на карточках: тот же, что открыт во вкладке.
    let siteBaseUrl = 'https://senkuro.com';

    const grid = document.getElementById('grid-container');
    const farmToggle = document.getElementById('farm-toggle');
    const farmStatusBadge = document.getElementById('farm-status-badge');
    const farmLog = document.getElementById('farm-log');
    const syncDialog = document.getElementById('sync-modal');
    const confirmDialog = document.getElementById('confirm-dialog');
    const scanStatus = document.getElementById('scan-status');

    // Переключение вкладок
    document.querySelectorAll('.tab-btn').forEach((btn) => {
        btn.addEventListener('click', (event) => {
            const target = event.currentTarget;

            document.querySelectorAll('.tab-btn').forEach((tab) => {
                tab.classList.remove('active');
                tab.removeAttribute('aria-current');
            });

            target.classList.add('active');
            target.setAttribute('aria-current', 'page');

            currentTab = target.getAttribute('data-tab');
            currentPage = 1;
            renderUI();
        });
    });

    function loadDataAndRender() {
        chrome.storage.local.get(['senkuroProgress'], (res) => {
            const progress = res.senkuroProgress || {};

            allTitlesArray = Object.values(progress).map((item) => {
                if (!item.slug) item.slug = item.title;
                return item;
            });

            renderUI();
        });
    }

    function renderUI() {
        document.querySelectorAll('.view-container').forEach((container) => {
            container.classList.remove('active');
        });

        if (currentTab === 'Статистика') {
            document.getElementById('view-stats').classList.add('active');
            renderStats();
        } else if (currentTab === 'Задания') {
            document.getElementById('view-tasks').classList.add('active');
            refreshTasks();
        } else if (currentTab === 'Фарм') {
            document.getElementById('view-farm').classList.add('active');
            refreshFarmStats();
        } else {
            document.getElementById('view-grid').classList.add('active');
            renderGrid();
        }
    }

    function createCard(data) {
        const displayTitle = data.title || data.slug;

        const card = document.createElement('div');
        card.className = 'card';
        if (data.isLicensed) card.classList.add('is-licensed');
        if (data.removedFromSite) card.classList.add('is-removed');

        const link = document.createElement('a');
        link.className = 'card-link';
        link.href = `${siteBaseUrl}/manga/${encodeURIComponent(data.slug)}`;
        link.target = '_blank';
        link.rel = 'noopener';

        const coverWrap = document.createElement('div');
        coverWrap.className = 'card-cover-wrap';

        const cover = document.createElement('img');
        cover.className = 'card-cover';
        cover.src = safeCoverUrl(data.coverUrl);
        cover.alt = '';
        cover.decoding = 'async';
        cover.width = 120;
        cover.height = 102;

        const topBadge = document.createElement('div');
        topBadge.className = 'tag-top';
        topBadge.textContent = data.isLicensed
            ? 'Лицензия'
            : (data.removedFromSite ? 'Удалён' : (data.globalStatus || 'Онгоинг'));

        coverWrap.append(cover, topBadge);

        if (data.format) {
            const formatBadge = document.createElement('div');
            formatBadge.className = 'tag-bottom';
            formatBadge.textContent = data.format;
            coverWrap.append(formatBadge);
        }

        const title = document.createElement('div');
        title.className = 'card-title';
        title.textContent = displayTitle;

        link.append(coverWrap, title);

        const chapterBox = document.createElement('div');
        chapterBox.className = 'chapter-box';

        const chapterInput = document.createElement('input');
        chapterInput.type = 'text';
        chapterInput.className = 'chapter-input';
        chapterInput.value = `Гл. ${data.lastChapter}`;
        chapterInput.readOnly = !data.isLicensed;
        chapterInput.setAttribute('aria-label', `Текущая глава: ${displayTitle}`);

        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'save-btn';
        saveBtn.dataset.slug = data.slug;
        saveBtn.textContent = 'ОК';
        saveBtn.setAttribute('aria-label', `Сохранить главу для «${displayTitle}»`);

        chapterBox.append(chapterInput, saveBtn);

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'delete-btn';
        deleteBtn.dataset.slug = data.slug;
        deleteBtn.setAttribute('aria-label', `Удалить «${displayTitle}» из плагина`);
        deleteBtn.textContent = '✖';

        card.append(link, chapterBox, deleteBtn);
        return card;
    }

    function renderGrid() {
        const filtered = allTitlesArray.filter((title) => {
            if (currentTab === 'Лицензии') return title.isLicensed;
            if (title.isLicensed) return false;
            if (title.removedFromSite) return true;
            if (currentTab === 'Читаю') return !title.userStatus || title.userStatus === 'Читаю';
            return title.userStatus === currentTab;
        });

        const totalPages = Math.ceil(filtered.length / itemsPerPage) || 1;
        if (currentPage > totalPages) currentPage = totalPages;

        const startIndex = (currentPage - 1) * itemsPerPage;
        const pageItems = filtered.slice(startIndex, startIndex + itemsPerPage);

        const fragment = document.createDocumentFragment();
        pageItems.forEach((data) => fragment.append(createCard(data)));
        grid.replaceChildren(fragment);

        document.getElementById('page-info').textContent = `${currentPage} / ${totalPages}`;
        document.getElementById('prev-page').disabled = currentPage === 1;
        document.getElementById('next-page').disabled = currentPage === totalPages;
    }

    grid.addEventListener('click', async (event) => {
        const saveBtn = event.target.closest('.save-btn');
        if (saveBtn) {
            const card = saveBtn.closest('.card');
            const chapterInput = card.querySelector('.chapter-input');
            const slugId = saveBtn.dataset.slug;
            const cleanValue = chapterInput.value.replace(/[^0-9.]/g, '');

            chrome.storage.local.get(['senkuroProgress'], (res) => {
                const progress = res.senkuroProgress || {};
                const titleKey = Object.keys(progress).find((key) => progress[key].slug === slugId || key === slugId);
                if (!titleKey) return;

                progress[titleKey].lastChapter = cleanValue;
                chrome.storage.local.set({ senkuroProgress: progress }, () => {
                    saveBtn.textContent = '✓';
                    setTimeout(loadDataAndRender, 500);
                });
            });
            return;
        }

        const deleteBtn = event.target.closest('.delete-btn');
        if (!deleteBtn) return;

        event.preventDefault();
        const slugId = deleteBtn.dataset.slug;
        const title = allTitlesArray.find((item) => item.slug === slugId)?.title || slugId;
        const confirmed = await confirmDelete(title);
        if (!confirmed) return;

        chrome.storage.local.get(['senkuroProgress'], (res) => {
            const progress = res.senkuroProgress || {};
            const titleKey = Object.keys(progress).find((key) => progress[key].slug === slugId || key === slugId);
            if (!titleKey) return;

            delete progress[titleKey];
            chrome.storage.local.set({ senkuroProgress: progress }, loadDataAndRender);
        });
    });

    function confirmDelete(title) {
        return new Promise((resolve) => {
            document.getElementById('confirm-text').textContent =
                `«${title}» будет удалён из базы плагина. Это действие нельзя отменить.`;
            confirmDialog.returnValue = '';

            confirmDialog.addEventListener('close', () => {
                resolve(confirmDialog.returnValue === 'confirm');
            }, { once: true });

            confirmDialog.showModal();
        });
    }

    document.getElementById('prev-page').addEventListener('click', () => {
        if (currentPage > 1) {
            currentPage--;
            renderGrid();
        }
    });

    document.getElementById('next-page').addEventListener('click', () => {
        currentPage++;
        renderGrid();
    });

    function createStatBox(title, value, colorClass = '', wide = false) {
        const box = document.createElement('div');
        box.className = `stat-box${wide ? ' stat-box-wide' : ''}`;

        const titleEl = document.createElement('div');
        titleEl.className = 'stat-title';
        titleEl.textContent = title;

        const valueEl = document.createElement('div');
        valueEl.className = `stat-val${colorClass ? ` ${colorClass}` : ''}`;
        valueEl.textContent = value;

        box.append(titleEl, valueEl);
        return box;
    }

    async function renderStats() {
        const stats = { total: allTitlesArray.length, chapters: 0, licensed: 0, formats: {}, statuses: {} };

        allTitlesArray.forEach((data) => {
            stats.chapters += Number.parseInt(data.lastChapter, 10) || 0;
            if (data.isLicensed) stats.licensed++;
            if (data.format) stats.formats[data.format] = (stats.formats[data.format] || 0) + 1;
            if (data.userStatus) stats.statuses[data.userStatus] = (stats.statuses[data.userStatus] || 0) + 1;
        });

        const topFormat = Object.entries(stats.formats).sort((a, b) => b[1] - a[1])[0];
        const fragment = document.createDocumentFragment();

        fragment.append(
            createStatBox('Тайтлов', stats.total, 'blue'),
            createStatBox('Глав', stats.chapters, 'green'),
            createStatBox('Читаю', stats.statuses['Читаю'] || 0, 'orange'),
            createStatBox('В планах', stats.statuses['В планах'] || 0),
            createStatBox('Прочитано', stats.statuses['Прочитано'] || 0),
            createStatBox('Лицензии', stats.licensed, 'red')
        );

        if (topFormat) {
            fragment.append(createStatBox('Любимый формат', `${topFormat[0]} (${topFormat[1]})`, 'pink', true));
        }

        // Задания, выполненные через расширение.
        const stored = await new Promise((resolve) => {
            chrome.storage.local.get(['senkuroTaskStats'], resolve);
        });
        const taskStats = stored.senkuroTaskStats || {};

        fragment.append(
            createStatBox('Циклов заданий', Math.round(taskStats.cycles || 0), 'purple'),
            createStatBox('Очки за задания', Math.round(taskStats.points || 0), 'orange'),
            createStatBox('Опыт за задания', Math.round(taskStats.exp || 0), 'green')
        );

        document.getElementById('stats-grid').replaceChildren(fragment);
    }

    // ===== ЗАДАНИЯ =====

    const TASK_NAMES = {
        'daily-visit': 'Заходить на сайт',
        'weekly-visit': 'Заходить на сайт каждую неделю',
        'monthly-visit': 'Заходить на сайт каждый месяц',
        'completed-3-tasks': 'Выполнить 3 задания',
        'completed-12-tasks': 'Выполнить 12 заданий',
        'leave-3-comments': 'Оставить 3 комментария',
        'receive-5-comment-upvote': 'Получить 5 лайков на комментарий',
        'split-card': 'Разделить карту',
        'merge-cards': 'Объединить карты',
        'merge-cards-3-times': 'Объединить карты 3 раза',
        'merge-cards-9-times': 'Объединить карты 9 раз',
        'upgrade-cards': 'Улучшить карты',
        'watch-18-anime-episodes': 'Посмотреть 18 эпизодов аниме',
        'watch-84-anime-episodes': 'Посмотреть 84 эпизода аниме',
        'rate-17-projects': 'Оценить 17 проектов',
        'add-5-bookmarks': 'Добавить 5 закладок',
        'add-20-bookmarks': 'Добавить 20 закладок',
        'update-profile-avatar': 'Обновить аватар профиля',
        'earn-2000-experience': 'Заработать 2000 опыта'
    };

    const TASK_TYPES = { DAILY: 'Ежедневное', WEEKLY: 'Еженедельное', MONTHLY: 'Ежемесячное' };

    /** Цель задания: число из слага (напр. completed-3-tasks → 3). */
    function taskTarget(slug) {
        const m = String(slug || '').match(/(\d+)/);
        return m ? Number(m[1]) : null;
    }

    /** Задания, которые можно автоматически выполнить (закладки, оценки). */
    const AUTO_TASK_RE = /^(add-\d+-bookmarks|rate-\d+-projects)$/;

    /** «Осталось времени» до дедлайна. */
    function formatRemaining(iso) {
        if (!iso) return null;
        const end = new Date(iso).getTime();
        if (!Number.isFinite(end)) return null;
        const diff = end - Date.now();
        if (diff <= 0) return 'время вышло';
        const totalMin = Math.floor(diff / 60000);
        if (totalMin < 60) return `${totalMin} мин`;
        const hours = Math.floor(totalMin / 60);
        if (hours < 24) return `${hours} ч ${totalMin % 60} мин`;
        const days = Math.floor(hours / 24);
        return `${days} д ${hours % 24} ч`;
    }

    function formatEndDate(iso) {
        if (!iso) return null;
        const d = new Date(iso);
        if (!Number.isFinite(d.getTime())) return null;
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const hh = String(d.getHours()).padStart(2, '0');
        const mi = String(d.getMinutes()).padStart(2, '0');
        return `${dd}.${mm} ${hh}:${mi}`;
    }

    function taskTitle(task) {
        const slug = task.slug || '';
        return TASK_NAMES[slug] || slug.replace(/-/g, ' ');
    }

    function renderTasks(tasks) {
        const list = document.getElementById('tasks-list');
        const fragment = document.createDocumentFragment();

        if (!tasks || !tasks.length) {
            const empty = document.createElement('div');
            empty.className = 'tasks-note';
            empty.textContent = 'Задания не загрузились. Проверьте, что открыта страница Senkuro.';
            fragment.append(empty);
            list.replaceChildren(fragment);
            return;
        }

        // Сортировка: сначала авто-задания, затем по ближайшему дедлайну.
        const sorted = [...tasks].sort((a, b) => {
            const aAuto = AUTO_TASK_RE.test(a.task.slug || '') ? 1 : 0;
            const bAuto = AUTO_TASK_RE.test(b.task.slug || '') ? 1 : 0;
            if (aAuto !== bAuto) return bAuto - aAuto;
            const ta = new Date(a.task.endAt || 0).getTime() || 0;
            const tb = new Date(b.task.endAt || 0).getTime() || 0;
            return ta - tb;
        });

        for (const item of sorted) {
            const task = item.task || {};
            const target = taskTarget(task.slug);
            const progress = Number(item.progress) || 0;
            const done = target !== null && progress >= target;

            const card = document.createElement('div');
            card.className = 'task-item';
            const typeClass = String(task.type || '').toLowerCase();
            if (typeClass === 'daily' || typeClass === 'weekly' || typeClass === 'monthly') {
                card.classList.add(`task-item--${typeClass}`);
            }

            const title = document.createElement('div');
            title.className = 'task-title';
            title.textContent = taskTitle(task);

            const meta = document.createElement('div');
            meta.className = 'task-meta';
            const remaining = formatRemaining(task.endAt);
            const endDate = formatEndDate(task.endAt);
            meta.textContent = `${TASK_TYPES[task.type] || task.type || ''} • ${task.slug}`;
            if (endDate) {
                meta.textContent += ` • До ${endDate} (осталось: ${remaining || '—'})`;
            }

            const progressLine = document.createElement('div');
            progressLine.className = 'task-progress';
            progressLine.textContent = `Прогресс: ${progress}${target !== null ? ` / ${target}` : ''}`;

            const bar = document.createElement('div');
            bar.className = 'task-bar';
            const fill = document.createElement('div');
            fill.className = 'task-bar-fill';
            fill.style.width = target && target > 0 ? `${Math.min(100, Math.round((progress / target) * 100))}%` : '0%';
            bar.append(fill);

            const rewards = document.createElement('div');
            rewards.className = 'task-meta';
            const parts = [];
            if (task.experience) parts.push(`⚡ ${task.experience} опыта`);
            if (task.points) parts.push(`🪙 ${task.points} очков`);
            rewards.textContent = parts.join(' • ') || '';

            const status = document.createElement('span');
            status.className = `task-status ${done ? 'task-status-ok' : 'task-status-active'}`;
            status.textContent = done ? '✓ Готово' : (task.active === false ? 'Неактивно' : 'Активно');

            card.append(title, meta, progressLine, bar, rewards, status);
            fragment.append(card);
        }

        list.replaceChildren(fragment);
    }

    function refreshTasks() {
        const load = (token) => sendToTab({ action: 'get_tasks', token }).then((res) => {
            if (res && res.error && /нет авторизации/i.test(res.error)) {
                // Повторяем с токеном из chrome.cookies (как в синхронизации).
                return getAccessTokenFromCookies().then((t) => (t ? sendToTab({ action: 'get_tasks', token: t }) : res));
            }
            return res;
        });

        load().then((res) => {
            const list = document.getElementById('tasks-list');
            if (res && res.tasks) {
                lastTasks = res.tasks;
                renderTasks(res.tasks);
            } else {
                list.replaceChildren();
                const err = document.createElement('div');
                err.className = 'tasks-error';
                err.textContent = res && res.error ? `Ошибка: ${res.error}` : 'Нет ответа от страницы.';
                list.append(err);
            }
        });
    }

    /** Порция награды за один цикл авто-задания (награда ÷ цель). */
    function taskRewardPerCycle(kind) {
        const auto = lastTasks.filter((t) => AUTO_TASK_RE.test(t.task.slug || '') && t.task.active !== false);
        const task = auto.find((t) => {
            const target = taskTarget(t.task.slug);
            return target && Number(t.progress) < target;
        }) || auto[0];
        if (!task) return null;

        const target = taskTarget(task.task.slug);
        if (!target || target <= 0) return null;

        return {
            points: (Number(task.task.points) || 0) / target,
            experience: (Number(task.task.experience) || 0) / target
        };
    }

    function addTaskStats(cycles, unit) {
        chrome.storage.local.get(['senkuroTaskStats'], (res) => {
            const s = res.senkuroTaskStats || { cycles: 0, points: 0, exp: 0 };
            s.cycles += cycles;
            if (unit) {
                s.points += unit.points * cycles;
                s.exp += unit.experience * cycles;
            }
            chrome.storage.local.set({ senkuroTaskStats: s });
        });
    }

    function runTask(kind) {
        const btn = kind === 'rate' ? document.getElementById('tasks-run-rate') : document.getElementById('tasks-run-bookmark');
        const note = document.getElementById('tasks-note');

        const rawCount = Number.parseInt(document.getElementById('tasks-count').value, 10);
        const count = Math.min(30, Math.max(1, Number.isFinite(rawCount) ? rawCount : 1));

        btn.disabled = true;
        note.textContent = `Выполняется на открытой странице манги… (циклов: ${count}, без влияния на библиотеку).`;

        sendToTab({ action: 'run_task', task: kind, count }).then((res) => {
            btn.disabled = false;
            if (res && res.ok) {
                note.textContent = `Выполнено циклов: ${res.done}. Прогресс обновляется с задержкой — нажмите «Обновить» позже.`;
                if (res.done > 0) {
                    addTaskStats(res.done, taskRewardPerCycle(kind));
                }
            } else {
                note.textContent = res && res.error ? `Ошибка: ${res.error}` : 'Не удалось выполнить.';
            }
            refreshTasks();
        });
    }

    document.getElementById('tasks-refresh').addEventListener('click', refreshTasks);
    document.getElementById('tasks-run-bookmark').addEventListener('click', () => runTask('bookmark'));
    document.getElementById('tasks-run-rate').addEventListener('click', () => runTask('rate'));

    function showModalView(viewId) {
        document.querySelectorAll('.modal-view').forEach((view) => view.classList.remove('active'));

        const view = document.getElementById(viewId);
        view.classList.add('active');

        const heading = view.querySelector('h2');
        if (heading) {
            syncDialog.setAttribute('aria-labelledby', heading.id);

            // После смены вида удерживаем фокус внутри диалога и озвучиваем новый заголовок.
            if (syncDialog.open) {
                heading.tabIndex = -1;
                heading.focus({ preventScroll: true });
            }
        }
    }

    function updateLog(text) {
        document.getElementById('sync-status-text').textContent = text;
    }

    function showScanStatus(text) {
        scanStatus.textContent = text;
        scanStatus.hidden = false;
    }

    function hideScanStatus() {
        scanStatus.hidden = true;
        scanStatus.textContent = '';
    }

    document.querySelectorAll('.close-modal-btn').forEach((btn) => {
        btn.addEventListener('click', () => syncDialog.close('cancel'));
    });

    syncDialog.addEventListener('cancel', (event) => {
        if (document.getElementById('view-progress').classList.contains('active')) {
            event.preventDefault();
        }
    });

    syncDialog.addEventListener('close', () => {
        pendingSyncData = null;
        syncDialog.returnValue = '';
        showModalView('view-warning');
    });

    document.getElementById('scan-btn').addEventListener('click', () => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const tab = tabs[0];
            if (!tab || !tab.url || !isSenkuroUrl(tab.url)) {
                showScanStatus("Сначала перейдите в «Мои Закладки» на сайте Senkuro.");
                return;
            }

            hideScanStatus();
            showModalView('view-warning');
            if (!syncDialog.open) syncDialog.showModal();
        });
    });

    function sendMessagePromise(tabId, message, timeoutMs = 15000) {
        return new Promise((resolve) => {
            let settled = false;

            const finish = (value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            };

            const timer = setTimeout(() => finish(null), timeoutMs);

            chrome.tabs.sendMessage(tabId, message, (response) => {
                if (chrome.runtime.lastError) {
                    finish(null);
                    return;
                }
                finish(response ?? null);
            });
        });
    }

    /**
     * access_token живёт в host-only куке senkuro.com / senkuro.me и не улетает
     * на api.senkuro.com сама. Читаем её через chrome.cookies (работает даже
     * для HttpOnly-кук) и передаём в контентный скрипт как Bearer-токен.
     */
    function getAccessTokenFromCookies() {
        return new Promise((resolve) => {
            if (!chrome.cookies || !chrome.cookies.get) {
                resolve(null);
                return;
            }
            const hosts = ['https://senkuro.com/', 'https://senkuro.me/'];
            let i = 0;
            const next = () => {
                if (i >= hosts.length) {
                    resolve(null);
                    return;
                }
                const url = hosts[i++];
                chrome.cookies.get({ url, name: 'access_token' }, (cookie) => {
                    if (chrome.runtime.lastError) {
                        next();
                        return;
                    }
                    resolve(cookie ? cookie.value : null);
                });
            };
            next();
        });
    }

    document.getElementById('btn-start-sync').addEventListener('click', async () => {
        showModalView('view-progress');
        globalHashMap = {};

        chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
            const tab = tabs[0];
            if (!tab || !tab.url || !isSenkuroUrl(tab.url)) {
                updateLog('[ОШИБКА] Откройте страницу Senkuro (senkuro.com или senkuro.me).');
                return;
            }

            try {
                updateLog('[АНАЛИЗ] Загрузка закладок через GraphQL API...');

                let response = await sendMessagePromise(tab.id, { action: 'sync_via_api' });

                // Первая попытка уходит с куками (credentials: 'include'). Если
                // сессия живёт в host-only куке senkuro.com, API её не видит —
                // достаём access_token через chrome.cookies и повторяем с Bearer.
                if (response && response.error && /нет авторизации/i.test(response.error)) {
                    const token = await getAccessTokenFromCookies();
                    if (token) {
                        updateLog('[АНАЛИЗ] Переподключение с токеном сессии...');
                        response = await sendMessagePromise(tab.id, { action: 'sync_via_api', token });
                    }
                }

                if (!response) {
                    updateLog('[ОШИБКА] Нет ответа от страницы. Перезагрузите страницу Senkuro.');
                    return;
                }

                if (response.error) {
                    updateLog(`[ОШИБКА] ${response.error}`);
                    return;
                }

                if (response.data) {
                    Object.assign(globalHashMap, response.data);
                }

                updateLog(`[АНАЛИЗ] Получено закладок: ${response.total ?? Object.keys(globalHashMap).length}.`);
                updateLog('[СИСТЕМА] Операция завершена.');
                await generateDiff(globalHashMap);
                showModalView('view-diff');
            } catch (error) {
                updateLog(`[ОШИБКА] ${error.message}`);
            }
        });
    });

    chrome.runtime.onMessage.addListener((request) => {
        if (request.action === 'sync_log') updateLog(request.text);
        if (request.action === 'farm_log') addFarmLog(request.text);
        if (request.action === 'farm_stats' && request.stats) updateFarmStatsUI(request.stats);
    });

    function generateDiff(scannedData) {
        return new Promise((resolve) => chrome.storage.local.get(['senkuroProgress'], (res) => {
            const current = res.senkuroProgress || {};

            // Копируем записи, чтобы правки отчёта не мутировали данные из storage.
            pendingSyncData = Object.fromEntries(
                Object.entries(current).map(([id, item]) => [id, { ...item }])
            );

            const diffBox = document.getElementById('diff-box');
            const fragment = document.createDocumentFragment();
            let hasChanges = false;

            const addLine = (className, text, sub = false) => {
                const line = document.createElement('div');
                line.className = `diff-${className}${sub ? ' diff-sub' : ''}`;
                line.textContent = text;
                fragment.append(line);
                hasChanges = true;
            };

            for (const [id, scanned] of Object.entries(scannedData)) {
                const stored = current[id];

                if (!stored) {
                    addLine('add', `[+] НОВЫЙ: ${scanned.title} (Гл: ${scanned.lastChapter})`);
                    if (scanned.isLicensed) addLine('rm', '↳ Блок (Лицензия)', true);
                    pendingSyncData[id] = { ...scanned };
                    continue;
                }

                const mods = [];
                const newChapter = Number.parseInt(scanned.lastChapter, 10) || 0;
                const oldChapter = Number.parseInt(stored.lastChapter, 10) || 0;

                if (stored.removedFromSite) {
                    addLine('add', `[*] ВОЗВРАЩЁН В ЗАКЛАДКИ: ${stored.title}`);
                }

                if (stored.isLicensed && !scanned.isLicensed) {
                    addLine('add', `[*] ВОССТАНОВЛЕН: «${stored.title}» больше не под лицензией!`);
                    addLine('mod', `↳ Сохранён ваш ручной прогресс: ${oldChapter} гл.`, true);
                    pendingSyncData[id].isLicensed = false;
                    if (oldChapter > newChapter) scanned.lastChapter = oldChapter;
                } else if (scanned.isLicensed && !stored.isLicensed) {
                    addLine('rm', `[-] ЛИЦЕНЗИЯ: «${stored.title}» заблокирован!`);
                    pendingSyncData[id].isLicensed = true;
                }

                if (!stored.isLicensed && newChapter > oldChapter) {
                    mods.push(`Гл: ${oldChapter}->${newChapter}`);
                    pendingSyncData[id].lastChapter = scanned.lastChapter;
                }

                if (scanned.userStatus !== stored.userStatus) {
                    mods.push(`Вкладка: ${stored.userStatus}->${scanned.userStatus}`);
                    pendingSyncData[id].userStatus = scanned.userStatus;
                }

                if (scanned.coverUrl) pendingSyncData[id].coverUrl = scanned.coverUrl;
                if (scanned.format) pendingSyncData[id].format = scanned.format;
                if (scanned.globalStatus) pendingSyncData[id].globalStatus = scanned.globalStatus;
                pendingSyncData[id].removedFromSite = false;

                if (mods.length > 0) {
                    addLine('mod', `[*] ИЗМЕНЕНО: ${stored.title} (${mods.join(', ')})`);
                }
            }

            for (const [id, stored] of Object.entries(current)) {
                if (Object.hasOwn(scannedData, id)) continue;

                addLine('rm', `[-] НЕТ В ЗАКЛАДКАХ: ${stored.title}`);
                addLine('mod', `↳ Остаётся в базе (прогресс: ${stored.lastChapter} гл.)`, true);
                pendingSyncData[id].removedFromSite = true;
            }

            if (!hasChanges) {
                const empty = document.createElement('div');
                empty.className = 'diff-empty';
                empty.textContent = 'Изменений не обнаружено. Данные актуальны.';
                fragment.append(empty);
            }

            diffBox.replaceChildren(fragment);
            resolve();
        }));
    }

    document.getElementById('btn-confirm-diff').addEventListener('click', () => {
        if (!pendingSyncData) return;

        chrome.storage.local.set({ senkuroProgress: pendingSyncData }, () => {
            syncDialog.close('save');
            loadDataAndRender();
        });
    });

    // ===== ФАРМ КАРТОЧЕК =====

    farmToggle.addEventListener('change', () => {
        if (farmToggle.checked) {
            startFarm();
        } else {
            stopFarm();
        }
    });

    function startFarm() {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const tab = tabs[0];
            if (!tab || !tab.url || !isSenkuroUrl(tab.url)) {
                farmToggle.checked = false;
                addFarmLog('Ошибка: откройте страницу чтения манги на Senkuro.');
                return;
            }

            sendToTab({ action: 'start_farm' }).then((res) => {
                if (res && res.success) {
                    setFarmRunning(true);
                    addFarmLog('Фарм запущен. Ритм чтения подстраивается под высоту страниц.');
                } else {
                    farmToggle.checked = false;
                    addFarmLog(`Ошибка: ${res ? res.error : 'Нет ответа от контента'}`);
                }
            });
        });
    }

    function stopFarm() {
        sendToTab({ action: 'stop_farm' }).then((res) => {
            setFarmRunning(false);
            if (res && res.stats) updateFarmStatsUI(res.stats);
        });
    }

    function setFarmRunning(running) {
        farmToggle.checked = running;
        farmStatusBadge.className = `farm-status ${running ? 'on' : 'off'}`;

        const dot = document.createElement('span');
        dot.className = 'farm-dot';
        dot.setAttribute('aria-hidden', 'true');
        farmStatusBadge.replaceChildren(dot, document.createTextNode(running ? 'Работает' : 'Выкл'));

        if (farmPollInterval) {
            clearInterval(farmPollInterval);
            farmPollInterval = null;
        }

        if (running) {
            farmPollInterval = setInterval(() => {
                sendToTab({ action: 'get_farm_stats' }).then((res) => {
                    if (!res) return;
                    updateFarmStatsUI(res);
                    if (!res.isRunning) setFarmRunning(false);
                });
            }, 1000);
        }
    }

    function updateFarmStatsUI(stats) {
        if (!stats) return;

        const session = stats.session || {};
        const global = stats.global || {};

        document.getElementById('f-s-cards').textContent = session.cardsCollected || 0;
        document.getElementById('f-s-pages').textContent = session.pagesChecked || 0;
        document.getElementById('f-s-time').textContent = formatTime(session.elapsed || 0);

        document.getElementById('f-g-cards').textContent = global.totalCards || 0;
        document.getElementById('f-g-time').textContent = formatTime(global.totalTime || 0);
    }

    function refreshFarmStats() {
        sendToTab({ action: 'get_farm_stats' }).then((res) => {
            if (res) updateFarmStatsUI(res);
        });

        farmLog.scrollTop = farmLog.scrollHeight;
    }

    function addFarmLog(text) {
        const now = new Date();
        const timestamp = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

        const entry = document.createElement('div');
        entry.className = 'farm-log-entry';
        entry.textContent = `[${timestamp}] ${text}`;
        farmLog.append(entry);

        while (farmLog.childElementCount > 200) {
            farmLog.firstElementChild.remove();
        }

        farmLog.scrollTop = farmLog.scrollHeight;
    }

    function sendToTab(message) {
        return new Promise((resolve) => {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (!tabs[0]) {
                    resolve(null);
                    return;
                }

                chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
                    void chrome.runtime.lastError;
                    resolve(response || null);
                });
            });
        });
    }

    function syncFarmState() {
        sendToTab({ action: 'get_farm_stats' }).then((res) => {
            if (!res) return;

            if (res.isRunning) {
                setFarmRunning(true);
                updateFarmStatsUI(res);
                addFarmLog('Фарм восстановлен');
            } else {
                setFarmRunning(false);
                updateFarmStatsUI(res);
            }
        });
    }

    // На старте определяем сайт активной вкладки, чтобы ссылки вели на тот же домен.
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        if (tab && tab.url) {
            try {
                const hostname = new URL(tab.url).hostname;
                if (hostname === 'senkuro.me') siteBaseUrl = 'https://senkuro.me';
            } catch {
                // Нестандартный URL — оставляем по умолчанию.
            }
        }
    });

    loadDataAndRender();
    syncFarmState();
});
