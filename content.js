const sleep = ms => new Promise(r => setTimeout(r, ms));

class CardFarmer {
    constructor() {
        this.isRunning = false;
        this.waitTime = 3000;
        this.attemptsPerPage = 3;
        this.sessionStats = { cardsCollected: 0, startTime: null, pagesChecked: 0 };
        this.globalStats = { totalCards: 0, totalTime: 0 };
        this._statsInterval = null;
    }

    isReadingPage() {
        return /\/manga\/[^/]+\/chapters\/\d+/.test(window.location.pathname);
    }

    async start(waitTime, attemptsPerPage) {
        if (this.isRunning) return { success: false, error: "Уже запущен" };
        if (!this.isReadingPage()) return { success: false, error: "Не на странице чтения. Откройте главу манги." };

        this.waitTime = (waitTime || 3) * 1000;
        this.attemptsPerPage = attemptsPerPage || 3;
        this.isRunning = true;
        this.sessionStats = { cardsCollected: 0, startTime: Date.now(), pagesChecked: 0 };

        const data = await chrome.storage.local.get("senkuroFarmStats");
        this.globalStats = data.senkuroFarmStats || { totalCards: 0, totalTime: 0 };

        this.log(`Старт: ${this.attemptsPerPage} попыток × ${this.waitTime / 1000}с на стр.`);
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

    _scrollToPage(num) {
        const items = document.querySelectorAll('.reader-item');
        if (items[num - 1]) {
            items[num - 1].scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    _clickNextPage() {
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

                this._scrollToPage(page);
                await sleep(800);

                let found = false;
                for (let attempt = 1; attempt <= this.attemptsPerPage && this.isRunning; attempt++) {
                    this.log(`  Попытка ${attempt}/${this.attemptsPerPage}...`);
                    await sleep(this.waitTime);
                    if (!this.isRunning) break;

                    const card = document.querySelector("img.cards-drop");
                    if (card) {
                        this.log(`  Нашёл! Клик...`);
                        card.click();

                        const modal = await this._waitForAny([".modal-container-drop", ".vfm__content.modal-drop"], 5000);
                        if (modal) {
                            await sleep(2500);
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
                        found = true;
                        break;
                    }
                }

                if (!found && this.isRunning) {
                    this.log(`  Пусто`);
                }
            }

            if (!this.isRunning) break;

            this.log("Следующая глава...");
            if (!this._clickNextChapter()) {
                this.log("Больше нет глав. Фарм завершён.");
                this.stop();
                break;
            }

            await sleep(4000);

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
    if (request.action === "start_farm") {
        cardFarmer.start(request.waitTime, request.attemptsPerPage).then(sendResponse);
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

