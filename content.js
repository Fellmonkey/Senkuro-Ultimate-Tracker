const sleep = ms => new Promise(r => setTimeout(r, ms));

class CardFarmer {
    constructor() {
        this.isRunning = false;
        // true — читалка в горизонтальном режиме: страницы листаются стрелкой.
        this.horizontalMode = false;
        this.sessionStats = { cardsCollected: 0, startTime: null, pagesChecked: 0 };
        this.globalStats = { totalCards: 0, totalTime: 0 };
        this._statsInterval = null;
    }

    isReadingPage() {
        return /\/manga\/[^/]+\/chapters\/\d+/.test(window.location.pathname);
    }

    async start() {
        if (this.isRunning) return { success: false, error: "Уже запущен" };
        if (!this.isReadingPage()) return { success: false, error: "Не на странице чтения. Откройте главу манги." };

        this.isRunning = true;
        this.sessionStats = { cardsCollected: 0, startTime: Date.now(), pagesChecked: 0 };

        const data = await chrome.storage.local.get("senkuroFarmStats");
        this.globalStats = data.senkuroFarmStats || { totalCards: 0, totalTime: 0 };

        // Горизонтальный режим исключает «задевание» соседних страниц скроллом.
        await this._ensureHorizontalMode();

        this.log(`Старт. Ритм чтения подстраивается под высоту страниц.`);
        this._statsInterval = setInterval(() => this._pushStats(), 1000);
        this._farmLoop();
        return { success: true };
    }

    stop() {
        if (!this.isRunning) return { success: false, error: "Не запущен" };
        this.isRunning = false;
        if (this._statsInterval) { clearInterval(this._statsInterval); this._statsInterval = null; }
        this._saveStats();
        this.log(`Стоп. Сессия: ${this.sessionStats.cardsCollected} карт / ${this.sessionStats.pagesChecked} стр.`);
        return { success: true, stats: this.getStats() };
    }

    _getTotalPages() {
        const el = document.querySelector('.nav-panel__page button span');
        if (el) {
            const m = el.textContent.match(/(\d+)\/(\d+)/);
            if (m) return parseInt(m[2]);
        }
        const items = document.querySelectorAll('.reader-item');
        return items.length || 1;
    }

    async _waitForTruthy(predicate, timeout) {
        const t0 = Date.now();
        while (Date.now() - t0 < timeout) {
            if (predicate()) return true;
            await sleep(100);
        }
        return false;
    }

    /**
     * Принудительное переключение радио-кнопки. Сначала обычный клик по
     * input (на реальном сайте работает даже для скрытого меню), затем клик
     * по видимой зоне и, наконец, прямая установка checked + события
     * input/change для v-model.
     */
    async _forceRadio(input) {
        if (!input) return false;

        input.click();
        await sleep(300);
        if (input.checked) return true;

        const label = input.closest('label');
        const visible = label ? label.querySelector('.radio-button__label') : null;
        const target = visible || label || input;

        target.dispatchEvent(new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            view: window
        }));
        await sleep(300);
        if (input.checked) return true;

        input.checked = true;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(300);

        return input.checked;
    }

    /**
     * Включает горизонтальный режим читалки. Достаточно переключить скрытое
     * радио HORIZONTAL — Vue-модель применяет режим без открытия меню
     * (проверено на реальном сайте). Открывать и закрывать меню не нужно.
     */
    async _ensureHorizontalMode() {
        const horizontal = document.querySelector('input[type="radio"][value="HORIZONTAL"]');
        if (!horizontal) {
            this.log('Радио режима чтения не найдено — продолжаем в текущем режиме.');
            return;
        }

        let switched = horizontal.checked;
        if (!switched) {
            for (let attempt = 0; attempt < 3 && !horizontal.checked; attempt++) {
                if (await this._forceRadio(horizontal)) break;
            }
            switched = horizontal.checked;
        }

        if (switched) {
            this.horizontalMode = true;
            this.log('Режим чтения: горизонтальный.');
            // Ждём перестроения читалки после смены режима.
            await sleep(800 + Math.random() * 700);
        } else {
            this.log('Не удалось включить горизонтальный режим чтения — продолжаем в текущем.');
        }
    }

    /**
     * Чтение страницы в горизонтальном режиме: страница уже на экране,
     * «читаем» её вертикально по экранам (как обычную страницу).
     */
    async _readPageHorizontal() {
        await this._readPage(1);
    }

    /** Текущий номер страницы из панели навигации, либо null. */
    _currentPageNumber() {
        const el = document.querySelector('.nav-panel__page button span');
        if (!el) return null;
        const m = el.textContent.match(/(\d+)\s*\/\s*(\d+)/);
        return m ? parseInt(m[1], 10) : null;
    }

    /** Ждёт, пока панель навигации покажет нужный номер страницы. */
    async _waitForPageNumber(expected, timeout) {
        const t0 = Date.now();
        while (Date.now() - t0 < timeout) {
            if (this._currentPageNumber() === expected) return true;
            await sleep(200);
        }
        return false;
    }

    /**
     * Имитация чтения страницы:
     * 1) ждём загрузку иллюстрации;
     * 2) разбиваем страницу на «экраны» по высоте окна;
     * 3) короткие страницы иногда просто пролистываются;
     * 4) читаем сверху вниз: шаг скролла + случайная пауза на экран;
     * 5) вариативность жестов: плавно/резко, изредка возврат назад;
     * 6) длинные страницы иногда не дочитываются до конца;
     * 7) редкие «заминки»; итоговое время — 3–45 с.
     */
    async _readPage(num) {
        const items = document.querySelectorAll('.reader-item');
        const item = items[num - 1];
        if (!item) {
            await sleep(1500 + Math.random() * 1000);
            return;
        }

        const img = item.querySelector('img');
        if (img && !img.complete) {
            await this._waitForTruthy(() => img.complete || img.naturalWidth > 0, 8000);
        }

        const viewportH = Math.max(window.innerHeight, 600);
        const itemRect = item.getBoundingClientRect();
        const height = Math.max(
            img ? Math.max(img.naturalHeight || 0, img.clientHeight || 0) : 0,
            itemRect.height || 0
        );
        let screens = Math.max(1, Math.round(height / viewportH));

        // Быстрое пролистывание маленьких страниц (меньше половины экрана).
        const small = height > 0 && height < viewportH * 0.5;
        if (small && Math.random() < 0.25) {
            const quick = 500 + Math.random() * 400;
            try {
                item.scrollIntoView({ behavior: 'auto', block: 'end' });
            } catch {
                // ignore
            }
            await sleep(quick);
            this.log(`  Пролистал (~${Math.round(quick / 1000)} с)`);
            return;
        }

        // Хвост: очень длинные страницы иногда пролистываются не до конца.
        let skipTail = 0;
        if (screens > 6 && Math.random() < 0.18) {
            skipTail = Math.max(1, Math.floor(screens * (0.1 + Math.random() * 0.2)));
            screens -= skipTail;
        }

        // Суммарное «время чтения»: база + время на каждый экран.
        let total = 1000 + Math.random() * 1500 + screens * (900 + Math.random() * 1400);
        total = Math.min(Math.max(total, 3000), 45000);

        try {
            item.scrollIntoView({ behavior: 'auto', block: 'start' });
        } catch {
            // Если scrollIntoView недоступен с этими опциями — продолжаем.
        }
        await sleep(200 + Math.random() * 400);

        this.log(`  Чтение ~${Math.round(total / 1000)} с (${screens} экр.)${skipTail ? ' — хвост пролистан' : ''}...`);

        for (let s = 1; s <= screens && this.isRunning; s++) {
            const first = s === 1;
            const last = s === screens;

            // Начало читается внимательнее, конец — быстрее.
            let weight = 1;
            if (first && screens > 1) weight *= 1.15 + Math.random() * 0.35;
            if (last && screens > 1) weight *= 0.65 + Math.random() * 0.25;
            const stepMs = (total / screens) * weight;

            const gesture = Math.random();
            if (gesture < 0.12 && !first) {
                // Лёгкий возврат назад — перечитал фрагмент.
                window.scrollBy({
                    top: -Math.floor(viewportH * (0.08 + Math.random() * 0.17)),
                    behavior: Math.random() < 0.5 ? 'smooth' : 'auto'
                });
                await sleep(stepMs * (0.4 + Math.random() * 0.6));
            } else {
                window.scrollBy({
                    top: Math.floor(viewportH * (0.55 + Math.random() * 0.35)),
                    behavior: Math.random() < 0.5 ? 'smooth' : 'auto'
                });
                await sleep(stepMs * (0.6 + Math.random() * 0.9));
            }

            // «Заминка»: на длинных страницах читатель отвлекается чаще.
            const pauseChance = screens > 6 ? 0.10 : 0.06;
            if (Math.random() < pauseChance && this.isRunning) {
                await sleep(1200 + Math.random() * 2800);
            }
        }

        // Перевод взгляда на следующую страницу.
        if (this.isRunning) {
            await sleep(250 + Math.random() * 450);
        }
    }

    _clickNextPage() {
        // В горизонтальном режиме страницы листаются зоной «Вперёд».
        const zone = document.querySelector('.tap-zone__next');
        if (zone && this._isVisible(zone)) {
            zone.click();
            return true;
        }

        const arrows = document.querySelectorAll('.nav-panel__bar-arrow');
        const rightArrow = arrows[arrows.length - 1];
        if (rightArrow && !rightArrow.disabled && !rightArrow.classList.contains('button--disabled')) {
            rightArrow.click();
            return true;
        }
        return false;
    }

    _clickNextChapter() {
        const btn = document.querySelector('button[aria-label="Следующая глава"]');
        if (btn && !btn.disabled && !btn.classList.contains('button--disabled')) {
            btn.click();
            return true;
        }
        const arrow = document.querySelector('.reader-chapters__arrow-right');
        if (arrow && !arrow.classList.contains('reader-chapters__arrow--disabled')) {
            arrow.click();
            return true;
        }
        // В горизонтальном режиме правая стрелка панели переключает главы.
        if (this.horizontalMode) {
            const arrows = document.querySelectorAll('.nav-panel__bar-arrow');
            const rightArrow = arrows[arrows.length - 1];
            if (rightArrow && !rightArrow.disabled && !rightArrow.classList.contains('button--disabled')) {
                rightArrow.click();
                return true;
            }
        }
        return false;
    }

    async _farmLoop() {
        while (this.isRunning) {
            if (!this.isReadingPage()) {
                this.log("Навигация ушла со страницы — стоп.");
                this.stop();
                break;
            }

            const totalPages = this._getTotalPages();
            const chapterName = this._getChapterName();
            this.log(`=== ${chapterName} | ${totalPages} стр. ===`);

            for (let page = 1; page <= totalPages && this.isRunning; page++) {
                this.sessionStats.pagesChecked++;
                this.log(`[Стр. ${page}/${totalPages}]`);

                if (this.horizontalMode) {
                    await this._readPageHorizontal();
                } else {
                    await this._readPage(page);
                }
                if (!this.isRunning) break;

                const card = document.querySelector("img.cards-drop");
                if (card) {
                    this.log(`  Нашёл! Клик...`);
                    card.click();

                    const modal = await this._waitForAny([".modal-container-drop", ".vfm__content.modal-drop"], 5000);
                    if (modal) {
                        // Человек осматривает карту: пауза тоже непостоянна.
                        await sleep(1500 + Math.random() * 2500);
                        await this._closeAnyModal();
                        const closed = await this._waitForAnyClose(3000);

                        if (closed) {
                            this.sessionStats.cardsCollected++;
                            this.globalStats.totalCards++;
                            this.log(`  Собрано! (+1 → ${this.sessionStats.cardsCollected})`);
                        } else {
                            this.log(`  Не удалось закрыть модалку`);
                        }
                    } else {
                        this.log(`  Модалка не появилась`);
                    }
                } else {
                    this.log(`  Карта не найдена`);
                }

                // В горизонтальном режиме страницы листаются стрелкой.
                if (this.horizontalMode && page < totalPages && this.isRunning) {
                    await sleep(300 + Math.random() * 600);
                    if (!this._clickNextPage()) {
                        this.log("Не удалось перейти на следующую страницу — стоп.");
                        this.stop();
                        break;
                    }
                    await this._waitForPageNumber(page + 1, 8000);
                }
            }

            if (!this.isRunning) break;

            // Короткий взгляд на конец главы перед переходом (~1 секунда).
            window.scrollBy({
                top: -Math.floor(Math.max(window.innerHeight * 0.08, 80)),
                behavior: 'smooth'
            });
            await sleep(400 + Math.random() * 600);

            this.log("Следующая глава...");
            if (!this._clickNextChapter()) {
                this.log("Больше нет глав. Фарм завершён.");
                this.stop();
                break;
            }

            // Небольшая непредсказуемость и при переходе на новую главу.
            await sleep(3000 + Math.random() * 4000);

            let waitAttempts = 0;
            while (this.isRunning && waitAttempts < 20) {
                const items = document.querySelectorAll('.reader-item');
                if (items.length > 0 && items[0].querySelector('img[src*="senkuro"]')) break;
                await sleep(500);
                waitAttempts++;
            }
        }
    }

    _getChapterName() {
        const h2 = document.querySelector('.nav-reader__caption h2');
        const p = document.querySelector('.nav-reader__caption p');
        const title = h2 ? h2.textContent.trim() : "";
        const chap = p ? p.textContent.trim() : "";
        return `${title} | ${chap}`.trim();
    }

    _isVisible(el) {
        if (!el || !el.offsetParent) return false;
        const s = window.getComputedStyle(el);
        return s.display !== "none" && s.opacity !== "0";
    }

    async _waitForAny(selectors, timeout) {
        const t0 = Date.now();
        while (Date.now() - t0 < timeout) {
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el && this._isVisible(el)) return el;
            }
            await sleep(100);
        }
        return null;
    }

    _visibleDrop() {
        const el = document.querySelector(".modal-container-drop, .modal-drop");
        return this._isVisible(el) ? el : null;
    }

    async _waitForAnyClose(timeout) {
        const t0 = Date.now();
        while (Date.now() - t0 < timeout) {
            if (!this._visibleDrop()) return true;
            await sleep(100);
        }
        return false;
    }

    async _closeAnyModal() {
        // Новое окно «Получена новая карта!»: закрывается кликом по подсказке
        // «Нажми, чтобы продолжить» (иногда — по фону). Пробуем оба варианта.
        for (const sel of [".modal-drop__info", ".vfm__overlay"]) {
            const el = document.querySelector(sel);
            if (!el) continue;
            el.click();
            await sleep(500);
            if (!this._visibleDrop()) return true;
        }

        const modal = this._visibleDrop();
        if (modal) modal.click();

        document.dispatchEvent(new KeyboardEvent("keydown", {
            key: "Escape", code: "Escape", keyCode: 27, bubbles: true
        }));
        return !this._visibleDrop();
    }

    async _saveStats() {
        if (!this.sessionStats.startTime) return;
        const elapsed = Date.now() - this.sessionStats.startTime;
        const totalTime = this.globalStats.totalTime + elapsed;
        await chrome.storage.local.set({
            senkuroFarmStats: { totalCards: this.globalStats.totalCards, totalTime }
        });
    }

    _pushStats() {
        chrome.runtime.sendMessage({ action: "farm_stats", stats: this.getStats() }).catch(() => {});
    }

    log(text) {
        chrome.runtime.sendMessage({ action: "farm_log", text }).catch(() => {});
    }

    getStats() {
        return {
            isRunning: this.isRunning,
            session: {
                cardsCollected: this.sessionStats.cardsCollected,
                pagesChecked: this.sessionStats.pagesChecked,
                elapsed: this.sessionStats.startTime ? Date.now() - this.sessionStats.startTime : 0
            },
            global: { ...this.globalStats }
        };
    }
}

const cardFarmer = new CardFarmer();

// ===== ЗАДАНИЯ =====

async function getTasksViaApi(token) {
    if (!window.SenkuroApi) {
        return { error: 'SenkuroApi не загружен в контентный скрипт' };
    }
    try {
        const options = {
            fetchImpl: (url, opts) => fetch(url, { ...opts, credentials: 'include' })
        };
        if (token) options.token = token;
        const tasks = await window.SenkuroApi.fetchTasks(options);
        return { tasks };
    } catch (error) {
        return { error: error.message || String(error) };
    }
}

function waitForSelector(selector, timeout) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        const timer = setInterval(() => {
            const el = document.querySelector(selector);
            if (el && el.offsetParent !== null || Date.now() - t0 > timeout) {
                clearInterval(timer);
                resolve(el && el.offsetParent !== null ? el : null);
            }
        }, 100);
    });
}

function findBtnByText(text, { outsideModal = false } = {}) {
    const match = typeof text === 'string' ? (t) => t === text : (t) => text.test(t);
    return [...document.querySelectorAll('button')].find((b) => {
        const t = (b.innerText || '').trim();
        if (!match(t)) return false;
        if (b.offsetParent === null) return false;
        if (outsideModal && b.closest('.rating-modal')) return false;
        return true;
    }) || null;
}

function waitForButtonIn(root, text, timeout) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        const check = () => {
            const btn = [...root.querySelectorAll('button')].find((b) =>
                (b.innerText || '').trim() === text && !b.disabled
            );
            if (btn || Date.now() - t0 > timeout) resolve(btn || null);
            else setTimeout(check, 100);
        };
        check();
    });
}

function isMangaPage() {
    return /^\/manga\//.test(window.location.pathname);
}

const BOOKMARK_STATUSES = ['Читаю', 'В планах', 'Прочитано', 'Любимое', 'Отложено', 'Брошено'];

/**
 * Цикл «добавить в закладки → удалить» с случайным статусом.
 * Прогресс задания растёт, библиотека возвращается в исходное состояние.
 */
async function runBookmarkCycle(count) {
    if (!isMangaPage()) return { ok: false, error: 'Откройте страницу манги' };
    let done = 0;
    for (let i = 0; i < count; i++) {
        const add = findBtnByText('Добавить в список');
        if (!add) break;
        add.click();
        await sleep(900);

        const status = BOOKMARK_STATUSES[Math.floor(Math.random() * BOOKMARK_STATUSES.length)];
        const statusBtn = findBtnByText(status);
        if (!statusBtn) break;
        statusBtn.click();
        await sleep(1500);

        const cur = findBtnByText(status);
        if (!cur) break;
        cur.click();
        await sleep(900);

        const remove = findBtnByText('Удалить из списка');
        if (!remove) {
            // Если пункта нет — закрываем меню и прерываем цикл.
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
            await sleep(800);
            break;
        }
        remove.click();
        await sleep(1800 + Math.random() * 1200);
        done++;
    }
    return { ok: true, done };
}

/**
 * Цикл «поставить оценку → снять голос» со случайным баллом.
 */
async function runRateCycle(count) {
    if (!isMangaPage()) return { ok: false, error: 'Откройте страницу манги' };
    let done = 0;
    for (let i = 0; i < count; i++) {
        // Открываем модалку оценки.
        const openBtn = findBtnByText('Оценить', { outsideModal: true }) || findBtnByText(/^Оценка/, { outsideModal: true });
        if (!openBtn) break;
        openBtn.click();
        const modal = await waitForSelector('.rating-modal', 5000);
        if (!modal) break;

        const icons = [...modal.querySelectorAll('.rating-modal__icon')];
        if (!icons.length) break;
        const star = icons[Math.floor(Math.random() * icons.length)];
        star.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        await sleep(700);

        const confirm = [...modal.querySelectorAll('button')].find((b) =>
            (b.innerText || '').trim() === 'Оценить' && !b.disabled
        );
        if (!confirm) break;
        confirm.click();

        // Ждём закрытия модалки и обновления кнопки.
        await sleep(2500);

        // Снимаем голос.
        const openAgain = findBtnByText(/^Оценка/, { outsideModal: true });
        if (!openAgain) { done++; continue; }
        openAgain.click();
        const modal2 = await waitForSelector('.rating-modal', 5000);
        if (!modal2) { done++; continue; }

        const removeVote = await waitForButtonIn(modal2, 'Удалить голос', 3000);
        if (removeVote) {
            removeVote.click();
            await sleep(1500);
        }
        await sleep(1800 + Math.random() * 1200);
        done++;
    }
    return { ok: true, done };
}

async function syncViaApi(token) {
    if (!window.SenkuroApi) {
        return { error: 'SenkuroApi не загружен в контентный скрипт' };
    }
    try {
        const options = {
            fetchImpl: (url, opts) => fetch(url, { ...opts, credentials: 'include' })
        };
        if (token) options.token = token;
        const result = await window.SenkuroApi.fetchBookmarks(options);
        return result;
    } catch (error) {
        return { error: error.message || String(error) };
    }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "sync_via_api") {
        syncViaApi(request.token).then(sendResponse);
        return true;
    }
    if (request.action === "get_tasks") {
        getTasksViaApi(request.token).then(sendResponse);
        return true;
    }
    if (request.action === "run_task") {
        const count = Math.min(Math.max(Number(request.count) || 3, 1), 30);
        const run = request.task === 'rate' ? runRateCycle(count) : runBookmarkCycle(count);
        run.then(sendResponse);
        return true;
    }
    if (request.action === "start_farm") {
        cardFarmer.start().then(sendResponse);
        return true;
    }
    if (request.action === "stop_farm") {
        sendResponse(cardFarmer.stop());
        return true;
    }
    if (request.action === "get_farm_stats") {
        sendResponse(cardFarmer.getStats());
        return true;
    }
});

