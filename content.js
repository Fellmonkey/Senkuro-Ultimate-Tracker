const sleep = ms => new Promise(r => setTimeout(r, ms));

// Обработка сообщений от popup.js
// ВАЖНО: return true обязателен для async sendResponse — иначе ответ не дойдёт
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "scan_tab") {
        scanSingleTab(request.tabName).then(sendResponse);
        return true;
    }
    if (request.action === "check_licenses") {
        checkLicensesBatch(request.ids).then(sendResponse);
        return true;
    }
});

/** Отправка логов в popup для отображения в UI синхронизации */
function logToPlugin(text) {
    chrome.runtime.sendMessage({ action: "sync_log", text: text }).catch(() => {});
}

/**
 * Сканирует одну вкладку закладок («Читаю», «В планах», «Прочитано»).
 *
 * Алгоритм:
 * 1. Находит нужную вкладку по тексту и кликает по ней
 * 2. Ждёт 2с для загрузки карточек
 * 3. Прокручивает страницу, собирая данные со всех article.card-main
 * 4. Если скролл застрял (4 попытки без новых данных) — сохраняет что есть
 *
 * @param {string} tabName - Название вкладки для сканирования
 * @returns {Promise<{success: boolean, data?: object, error?: string}>}
 */
async function scanSingleTab(tabName) {
    let collectedMap = new Map();

    const tabs = Array.from(document.querySelectorAll('.favorites-filter .tabs-tab'));
    const targetTab = tabs.find(t => t.innerText.includes(tabName));

    if (!targetTab) return { success: false, error: "Вкладка не найдена" };

    targetTab.click();
    await sleep(2000);

    const countElem = targetTab.querySelector('.favorites-count');
    const expectedCount = countElem ? parseInt(countElem.innerText) : 0;

    if (expectedCount === 0) return { success: true, data: {} };

    let stuckAttempts = 0;
    let prevCount = 0;

    logToPlugin(`[СКРОЛЛИНГ] ${tabName}: 0 / ${expectedCount}`);

    while (collectedMap.size < expectedCount) {
        document.querySelectorAll('article.card-main').forEach(card => {
            const link = card.querySelector('a[href^="/manga/"]');
            if (!link) return;

            const mangaId = link.getAttribute('href').match(/\/manga\/([^\/]+)/)[1];
            if (collectedMap.has(mangaId)) return;

            const titleElem = card.querySelector('.card-title');
            const imgElem = card.querySelector('.cover-wrapper img');
            const statusUp = card.querySelector('.card-status__up');
            const formatDown = card.querySelector('.card-status__down');

            let chapter = "0";
            if (statusUp) {
                const parts = statusUp.innerText.split('·');
                if (parts.length > 1) chapter = parts[1].replace(/[^0-9.]/g, '');
            }

            collectedMap.set(mangaId, {
                slug: mangaId,
                title: titleElem ? titleElem.innerText.trim() : mangaId,
                lastChapter: chapter,
                format: formatDown ? formatDown.innerText.replace('<!---->','').trim() : "",
                userStatus: tabName,
                coverUrl: imgElem ? (imgElem.getAttribute('src') || imgElem.getAttribute('data-zoom-src')) : '',
                isLicensed: false,
                date: new Date().toLocaleDateString()
            });
        });

        logToPlugin(`[СКРОЛЛИНГ] ${tabName}: ${collectedMap.size} / ${expectedCount}`);
        if (collectedMap.size >= expectedCount) break;

        // Плавно скроллит вниз для загрузки ленивых карточек
        for (let i = 0; i < 3; i++) {
            window.scrollBy({ top: 600, behavior: 'smooth' });
            document.dispatchEvent(new WheelEvent('wheel', { deltaY: 600, bubbles: true }));
            await sleep(300);
        }

        // Если скролл застрял — extreme scroll (вверх-вниз)
        if (collectedMap.size === prevCount) {
            stuckAttempts++;
            window.scrollTo(0, 0);
            await sleep(600);
            window.scrollTo(0, document.body.scrollHeight);
            await sleep(600);

            if (stuckAttempts > 4) {
                logToPlugin(`[ВНИМАНИЕ] Сайт отдал не все данные. Сохраняем доступные.`);
                break;
            }
        } else {
            stuckAttempts = 0;
        }
        prevCount = collectedMap.size;
    }

    return { success: true, data: Object.fromEntries(collectedMap) };
}

/**
 * Проверяет лицензии для списка тайтлов.
 *
 * Запрашивает /manga/{id}/chapters (страницу глав) для каждого ID.
 * Лицензия определяется по наличию класса empty__label + ключевых слов
 * о правеобладателях / удалении.
 *
 * Также парсит глобальный статус тайтла (Онгоинг/Завершён/Заморожен и т.д.)
 *
 * @param {string[]} ids - Массив slug-ов тайтлов
 * @returns {Promise<Object>} - { [id]: { isLicensed: boolean, globalStatus: string } }
 */
async function checkLicensesBatch(ids) {
    let results = {};
    await Promise.all(ids.map(async (id) => {
        try {
            const res = await fetch(`/manga/${id}/chapters`);
            const html = await res.text();

            let isLicensed = false;
            let globalStatus = "Онгоинг";

            if (html.includes('empty__label') && (html.includes('правообладател') || html.includes('удален') || html.includes('закон'))) {
                isLicensed = true;
            }

            // Извлекаем статус тайтла из бокового меню
            const statusMatch = html.match(/Статус тайтла[\s\S]*?class="chip[^>]*><\/span>\s*([^<]+)<\/a>/);
            if (statusMatch) globalStatus = statusMatch[1].trim();

            results[id] = { isLicensed, globalStatus };
        } catch (e) {}
    }));
    return results;
}
