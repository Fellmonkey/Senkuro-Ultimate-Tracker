const sleep = ms => new Promise(r => setTimeout(r, ms));

document.addEventListener('DOMContentLoaded', () => {
    let allTitlesArray = [];
    let currentTab = 'Читаю';
    let currentPage = 1;
    const itemsPerPage = 9;

    let globalHashMap = {};     // Временное хранилище отсканированных данных перед сохранением
    let pendingSyncData = null; // Данные, ожидающие подтверждения через diff-отчёт

    // Переключение вкладок (Читаю / В планах / Прочитано / Лицензии / Статистика)
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');

            currentTab = e.target.getAttribute('data-tab');
            currentPage = 1;
            renderUI();
        });
    });

    /** Загружает данные из chrome.storage и перерисовывает UI */
    function loadDataAndRender() {
        chrome.storage.local.get(['senkuroProgress'], (res) => {
            const progress = res.senkuroProgress || {};
            allTitlesArray = Object.values(progress).map(item => {
                if (!item.slug) item.slug = item.title;
                return item;
            });
            renderUI();
        });
    }

    /** Переключает между видом сетки и видом статистики */
    function renderUI() {
        document.querySelectorAll('.view-container').forEach(c => c.classList.remove('active'));
        if (currentTab === 'Статистика') {
            document.getElementById('view-stats').classList.add('active');
            renderStats();
        } else {
            document.getElementById('view-grid').classList.add('active');
            renderGrid();
        }
    }

    /**
     * Отрисовывает сетку карточек тайтлов с пагинацией.
     *
     * Фильтрация:
     * - «Лицензии» — показывает только лицензированные
     * - Остальные вкладки — исключает лицензированные и фильтрует по userStatus
     * - «Читаю» по умолчанию включает тайтлы без статуса
     */
    function renderGrid() {
        let filtered = allTitlesArray.filter(t => {
            if (currentTab === 'Лицензии') return t.isLicensed;
            if (t.isLicensed) return false;
            if (t.removedFromSite) return true;
            if (currentTab === 'Читаю') return !t.userStatus || t.userStatus === 'Читаю';
            return t.userStatus === currentTab;
        });

        const totalPages = Math.ceil(filtered.length / itemsPerPage) || 1;
        if (currentPage > totalPages) currentPage = totalPages;

        const startIdx = (currentPage - 1) * itemsPerPage;
        const pageItems = filtered.slice(startIdx, startIdx + itemsPerPage);

        const grid = document.getElementById('grid-container');
        grid.innerHTML = '';

        pageItems.forEach(data => {
            const card = document.createElement('div');
            card.className = `card ${data.isLicensed ? 'is-licensed' : ''} ${data.removedFromSite ? 'is-removed' : ''}`;

            // Фолбэк-картинка (серый блок) если обложка отсутствует
            let fallbackImg = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><rect width="100%" height="100%" fill="%2345475a"/></svg>';
            let img = data.coverUrl ? data.coverUrl : fallbackImg;
            let topBadge = data.isLicensed ? 'Лицензия' : (data.removedFromSite ? 'Удалён' : (data.globalStatus || 'Онгоинг'));

            card.innerHTML = `
                <button class="delete-btn" data-id="${data.slug}" title="Удалить из плагина">✖</button>
                <a href="https://senkuro.com/manga/${data.slug}" target="_blank" class="card-link" title="${data.title}">
                    <div class="card-cover-wrap">
                        <img src="${img}" class="card-cover" loading="lazy">
                        <div class="tag-top">${topBadge}</div>
                        ${data.format ? `<div class="tag-bottom">${data.format}</div>` : ''}
                    </div>
                    <div class="card-title">${data.title}</div>
                </a>
                <div class="chapter-box">
                    <input type="text" class="chapter-input" id="chap-${data.slug}" value="Гл. ${data.lastChapter}" ${data.isLicensed ? '' : 'readonly'}>
                    <button class="save-btn" data-id="${data.slug}">ОК</button>
                </div>
            `;
            grid.appendChild(card);
        });

        // Обработчик сохранения главы (только для лицензированных тайтлов)
        document.querySelectorAll('.save-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const slugId = e.target.getAttribute('data-id');
                const cleanVal = document.getElementById(`chap-${slugId}`).value.replace(/[^0-9.]/g, '');

                chrome.storage.local.get(['senkuroProgress'], (res) => {
                    let prog = res.senkuroProgress || {};
                    const tKey = Object.keys(prog).find(k => prog[k].slug === slugId || k === slugId);

                    if (tKey) {
                        prog[tKey].lastChapter = cleanVal;
                        chrome.storage.local.set({ senkuroProgress: prog }, () => {
                            e.target.innerText = "✓";
                            setTimeout(() => loadDataAndRender(), 500);
                        });
                    }
                });
            });
        });

        // Обработчик удаления тайтла из базы
        document.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                if (confirm("Вы уверены, что хотите удалить этот тайтл из базы плагина?")) {
                    const slugId = e.target.getAttribute('data-id');
                    chrome.storage.local.get(['senkuroProgress'], (res) => {
                        let prog = res.senkuroProgress || {};
                        const tKey = Object.keys(prog).find(k => prog[k].slug === slugId || k === slugId);
                        if (tKey) {
                            delete prog[tKey];
                            chrome.storage.local.set({ senkuroProgress: prog }, () => loadDataAndRender());
                        }
                    });
                }
            });
        });

        document.getElementById('page-info').innerText = `${currentPage} / ${totalPages}`;
        document.getElementById('prev-page').disabled = currentPage === 1;
        document.getElementById('next-page').disabled = currentPage === totalPages;
    }

    document.getElementById('prev-page').addEventListener('click', () => {
        if (currentPage > 1) { currentPage--; renderGrid(); }
    });
    document.getElementById('next-page').addEventListener('click', () => {
        currentPage++; renderGrid();
    });

    /** Рендерит статистику: общее кол-во тайтлов, глав, статусов, форматов */
    function renderStats() {
        let stats = { total: allTitlesArray.length, chapters: 0, licensed: 0, formats: {}, statuses: {} };
        allTitlesArray.forEach(data => {
            stats.chapters += parseInt(data.lastChapter) || 0;
            if (data.isLicensed) stats.licensed++;
            if (data.format) stats.formats[data.format] = (stats.formats[data.format] || 0) + 1;
            if (data.userStatus) stats.statuses[data.userStatus] = (stats.statuses[data.userStatus] || 0) + 1;
        });

        const topFormat = Object.entries(stats.formats).sort((a,b) => b[1] - a[1])[0];
        document.getElementById('stats-grid').innerHTML = `
            <div class="stat-box"><div class="stat-title">Тайтлов</div><div class="stat-val" style="color:#89b4fa">${stats.total}</div></div>
            <div class="stat-box"><div class="stat-title">Глав</div><div class="stat-val" style="color:#a6e3a1">${stats.chapters}</div></div>
            <div class="stat-box"><div class="stat-title">Читаю</div><div class="stat-val" style="color:#fab387">${stats.statuses['Читаю'] || 0}</div></div>
            <div class="stat-box"><div class="stat-title">В планах</div><div class="stat-val">${stats.statuses['В планах'] || 0}</div></div>
            <div class="stat-box"><div class="stat-title">Прочитано</div><div class="stat-val">${stats.statuses['Прочитано'] || 0}</div></div>
            <div class="stat-box"><div class="stat-title">Лицензии</div><div class="stat-val" style="color:#f38ba8">${stats.licensed}</div></div>
            ${topFormat ? `<div class="stat-box" style="grid-column: span 2;"><div class="stat-title">Любимый формат</div><div class="stat-val" style="color:#f5c2e7;">${topFormat[0]} (${topFormat[1]})</div></div>` : ''}
        `;
    }

    /** Показывает нужный экран модального окна */
    function showModalView(viewId) {
        document.querySelectorAll('.modal-view').forEach(v => v.classList.remove('active'));
        document.getElementById(viewId).classList.add('active');
    }

    function updateLog(text) { document.getElementById('sync-status-text').innerText = text; }

    document.querySelectorAll('.close-modal-btn').forEach(btn => {
        btn.addEventListener('click', () => { document.getElementById('sync-modal').style.display = 'none'; });
    });

    // Кнопка «Синхронизировать библиотеку» — открывает модалку с предупреждением
    document.getElementById('scan-btn').addEventListener('click', () => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (!tabs[0].url.includes("senkuro")) return alert("Сначала перейдите в 'Мои Закладки' на сайте Senkuro.");
            document.getElementById('sync-modal').style.display = 'block';
            showModalView('view-warning');
        });
    });

    /**
     * Перезагружает вкладку и ждёт 4с для полной загрузки.
     * Нужно потому что scanSingleTab работает с DOM текущей страницы.
     */
    function reloadTabAndWait(tabId) {
        return new Promise(resolve => { chrome.tabs.reload(tabId, {}, () => { setTimeout(resolve, 4000); }); });
    }
    function sendMessagePromise(tabId, msg) {
        return new Promise(resolve => { chrome.tabs.sendMessage(tabId, msg, (res) => resolve(res)); });
    }

    /**
     * Основной поток синхронизации:
     * 1. Перезагружает страницу для каждой вкладки (Читаю → В планах → Прочитано)
     * 2. Сканирует данные через content.js
     * 3. Проверяет лицензии батчами по 4 тайтла
     * 4. Генерирует diff и показывает пользователю
     *
     * ВАЖНО: Страница перезагружается 3 раза, пользователь не должен взаимодействовать
     * со страницей до завершения (окно «моргает»).
     */
    document.getElementById('btn-start-sync').addEventListener('click', async () => {
        showModalView('view-progress');
        globalHashMap = {};

        chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
            const tabId = tabs[0].id;
            const tabsToScan = ['Читаю', 'В планах', 'Прочитано'];

            for (let tName of tabsToScan) {
                updateLog(`[СИСТЕМА] Перезагрузка: ${tName}...`);
                await reloadTabAndWait(tabId);

                updateLog(`[АНАЛИЗ] Сбор данных: ${tName}...`);
                const res = await sendMessagePromise(tabId, { action: "scan_tab", tabName: tName });
                if (res && res.data) Object.assign(globalHashMap, res.data);
            }

            // Проверка лицензий батчами (по 4 параллельных запроса)
            const ids = Object.keys(globalHashMap);
            const batchSize = 4;

            for (let i = 0; i < ids.length; i += batchSize) {
                updateLog(`[АНАЛИЗ ЛИЦЕНЗИЙ] ${i} из ${ids.length}`);
                const batch = ids.slice(i, i + batchSize);
                const licRes = await sendMessagePromise(tabId, { action: "check_licenses", ids: batch });

                if (licRes) {
                    for (let id in licRes) {
                        globalHashMap[id].isLicensed = licRes[id].isLicensed;
                        globalHashMap[id].globalStatus = licRes[id].globalStatus;
                    }
                }
            }

            updateLog(`[СИСТЕМА] Операция завершена.`);
            generateDiff(globalHashMap);
            showModalView('view-diff');
        });
    });

    // Приём логов от content.js для отображения в UI
    chrome.runtime.onMessage.addListener((req) => { if (req.action === "sync_log") updateLog(req.text); });

    /**
     * Генерирует отчёт об изменениях (diff) между отсканированными данными и хранилищем.
     *
     * Типы изменений:
     * [+] НОВЫЙ — тайтл есть в скане, но нет в хранилище
     * [-] ЛИЦЕНЗИЯ — тайтл получил лицензию (блокируется)
     * [*] ВОССТАНОВЛЕН — тайтл больше не под лицензией
     * [*] ИЗМЕНЕНО — обновлена глава или статус вкладки
     * [-] УДАЛЕНО ИЗ ЗАКЛАДОК — тайтл есть в хранилище, но нет в скане
     *
     * @param {Object} scannedData - Данные, полученные от content.js
     */
    function generateDiff(scannedData) {
        chrome.storage.local.get(['senkuroProgress'], (res) => {
            const current = res.senkuroProgress || {};
            pendingSyncData = { ...current };
            let diffHTML = "";

            for (const [id, sData] of Object.entries(scannedData)) {
                let pData = current[id];

                if (!pData) {
                    // Новый тайтл — добавляем
                    diffHTML += `<div class="diff-add">[+] НОВЫЙ: ${sData.title} (Гл: ${sData.lastChapter})</div>`;
                    if (sData.isLicensed) diffHTML += `<div class="diff-rm">&nbsp;&nbsp;↳ Блок (Лицензия)</div>`;
                    pendingSyncData[id] = sData;
                } else {
                    let mods = [];
                    const newChap = parseInt(sData.lastChapter) || 0;
                    const oldChap = parseInt(pData.lastChapter) || 0;

                    // Обработка лицензий: восстановление или блокировка
                    if (pData.isLicensed && !sData.isLicensed) {
                        diffHTML += `<div class="diff-add">[*] ВОССТАНОВЛЕН: «${pData.title}» больше не под лицензией!</div>`;
                        diffHTML += `<div class="diff-mod">&nbsp;&nbsp;↳ Сохранен ваш ручной прогресс: ${oldChap} гл.</div>`;
                        pendingSyncData[id].isLicensed = false;
                        if (oldChap > newChap) sData.lastChapter = oldChap;
                    } else if (sData.isLicensed && !pData.isLicensed) {
                        diffHTML += `<div class="diff-rm">[-] ЛИЦЕНЗИЯ: «${pData.title}» заблокирован!</div>`;
                        pendingSyncData[id].isLicensed = true;
                    }

                    // Обновление главы (только если глава выросла)
                    if (!pData.isLicensed && newChap > oldChap) {
                        mods.push(`Гл: ${oldChap}->${newChap}`);
                        pendingSyncData[id].lastChapter = sData.lastChapter;
                    }

                    // Обновление статуса вкладки
                    if (sData.userStatus !== pData.userStatus) {
                        mods.push(`Вкладка: ${pData.userStatus}->${sData.userStatus}`);
                        pendingSyncData[id].userStatus = sData.userStatus;
                    }

                    // Всегда обновляем обложку и формат
                    pendingSyncData[id].coverUrl = sData.coverUrl;
                    pendingSyncData[id].format = sData.format;
                    if (sData.globalStatus) pendingSyncData[id].globalStatus = sData.globalStatus;

                    if (mods.length > 0) diffHTML += `<div class="diff-mod">[*] ИЗМЕНЕНО: ${pData.title} (${mods.join(', ')})</div>`;
                }
            }

            // Тайтлы, отсутствующие в текущем скане — помечаем как «мертвые души»
            for (const [id, pData] of Object.entries(current)) {
                if (!scannedData[id]) {
                    diffHTML += `<div class="diff-rm">[-] НЕТ В ЗАКЛАДКАХ: ${pData.title}</div>`;
                    diffHTML += `<div class="diff-mod">&nbsp;&nbsp;↳ Остаётся в базе (прогресс: ${pData.lastChapter} гл.)</div>`;
                    pendingSyncData[id].removedFromSite = true;
                }
            }

            if (!diffHTML) diffHTML = "<div style='color:#a6adc8; text-align:center;'><br>Изменений не обнаружено. Данные актуальны.</div>";
            document.getElementById('diff-box').innerHTML = diffHTML;
        });
    }

    // Подтверждение сохранения diff-а в хранилище
    document.getElementById('btn-confirm-diff').addEventListener('click', () => {
        if (pendingSyncData) {
            chrome.storage.local.set({ senkuroProgress: pendingSyncData }, () => {
                document.getElementById('sync-modal').style.display = 'none';
                loadDataAndRender();
            });
        }
    });

    loadDataAndRender();
});
