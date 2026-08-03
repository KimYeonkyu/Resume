const state = {
    projects: [],
    currentProjectId: null,
    currentItemIndex: 0,
    lastFocusedElement: null,
    viewerInfoTimer: null,
    touchStartX: null,
    touchStartY: null,
    inertStates: [],
    contactInertStates: [],
    contactLastFocusedElement: null,
    accessFlowGeneration: 0,
};

const ACCESS_MODE_KEY = 'portfolio-access-mode';
const STATIC_PUBLIC_HOSTNAME = 'kimyeonkyu.github.io';
const INTERVIEW_URL = (() => {
    const raw = document.querySelector('meta[name="portfolio-interview-url"]')?.content ?? '';
    try {
        const parsed = new URL(raw);
        if (
            parsed.protocol !== 'https:'
            || parsed.hostname !== 'minionion.duckdns.org'
            || parsed.port
            || parsed.pathname !== '/jin_kim_portfolio.html'
            || parsed.search !== '?mode=interview'
            || parsed.hash
            || parsed.username
            || parsed.password
        ) return null;
        return parsed.href;
    } catch {
        return null;
    }
})();

function isStaticPublicSite() {
    return window.location.hostname === STATIC_PUBLIC_HOSTNAME;
}

const elements = {
    entrance: document.querySelector('#entrance-screen'),
    entranceActions: document.querySelector('#entrance-actions'),
    interviewChoice: document.querySelector('#interview-choice'),
    publicChoice: document.querySelector('#public-choice'),
    loginForm: document.querySelector('#login-form'),
    loginBack: document.querySelector('#login-back'),
    passwordInput: document.querySelector('#password-input'),
    loginError: document.querySelector('#login-error'),
    entranceStatus: document.querySelector('#entrance-status'),
    galleryShell: document.querySelector('#gallery-shell'),
    galleryTitle: document.querySelector('#gallery-title'),
    categoryTabs: document.querySelector('#category-tabs'),
    artworkCount: document.querySelector('#artwork-count'),
    galleryGrid: document.querySelector('#gallery-grid'),
    galleryError: document.querySelector('#gallery-error'),
    accessStatus: document.querySelector('#access-status'),
    relockButton: document.querySelector('#relock-button'),
    detailModal: document.querySelector('#detail-modal'),
    modalClose: document.querySelector('#modal-close-button'),
    previousButton: document.querySelector('#previous-button'),
    nextButton: document.querySelector('#next-button'),
    modalMedia: document.querySelector('#modal-media-container'),
    modalInfo: document.querySelector('#modal-info'),
    modalCategory: document.querySelector('#modal-category'),
    modalTitle: document.querySelector('#modal-title'),
    modalDescription: document.querySelector('#modal-description'),
    contactButton: document.querySelector('#contact-button'),
    contactModal: document.querySelector('#contact-modal'),
    contactClose: document.querySelector('#contact-close-button'),
};

function currentProject() {
    return state.projects.find((project) => project.id === state.currentProjectId) ?? null;
}

function beginAccessFlow() {
    state.accessFlowGeneration += 1;
    return state.accessFlowGeneration;
}

function isCurrentAccessFlow(generation) {
    return state.accessFlowGeneration === generation;
}

async function requestJson(url, options = {}) {
    const headers = { Accept: 'application/json', ...(options.headers ?? {}) };
    const response = await fetch(url, {
        credentials: 'same-origin',
        ...options,
        headers,
    });
    if (!response.ok) throw new Error('Portfolio request failed');
    return response.json();
}

function showLoginForm() {
    beginAccessFlow();
    elements.entranceActions.hidden = true;
    elements.loginForm.hidden = false;
    elements.loginError.textContent = '';
    elements.entranceStatus.textContent = '';
    requestAnimationFrame(() => elements.passwordInput.focus());
}

function showEntranceChoices() {
    beginAccessFlow();
    elements.loginForm.hidden = true;
    elements.entranceActions.hidden = false;
    elements.passwordInput.value = '';
    elements.loginError.textContent = '';
    requestAnimationFrame(() => elements.interviewChoice.focus());
}

async function enterPublicPortfolio() {
    const generation = beginAccessFlow();
    sessionStorage.setItem(ACCESS_MODE_KEY, 'public');
    elements.publicChoice.disabled = true;
    elements.entranceStatus.textContent = '';
    try {
        let manifest;
        if (isStaticPublicSite()) {
            manifest = await requestJson('./public-portfolio-manifest.json');
        } else {
            const logoutResponse = await fetch('/api/auth/logout', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { Accept: 'application/json' },
            });
            if (!logoutResponse.ok) throw new Error('Guest session reset failed');
            if (!isCurrentAccessFlow(generation)) return;
            manifest = await requestJson('/api/projects?mode=public');
        }
        if (!isCurrentAccessFlow(generation)) return;
        showGallery(manifest);
    } catch {
        if (!isCurrentAccessFlow(generation)) return;
        elements.entranceStatus.textContent = '포트폴리오를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.';
    } finally {
        elements.publicChoice.disabled = false;
    }
}

function enterInterviewPortfolio() {
    if (isStaticPublicSite()) {
        if (!INTERVIEW_URL) {
            elements.entranceStatus.textContent = '면접용 포트폴리오 주소를 확인할 수 없습니다.';
            return;
        }
        window.location.assign(INTERVIEW_URL);
        return;
    }
    showLoginForm();
}

function showGallery(manifest) {
    state.projects = Array.isArray(manifest.projects) ? manifest.projects : [];
    state.currentProjectId = state.projects[0]?.id ?? null;
    elements.entrance.hidden = true;
    elements.galleryShell.hidden = false;
    elements.accessStatus.textContent = manifest.authenticated ? '면접용 전체 보기' : '공개 보기';
    elements.relockButton.hidden = !manifest.authenticated;
    elements.passwordInput.value = '';
    elements.loginError.textContent = '';
    elements.entranceStatus.textContent = '';
    renderTabs();
    renderGallery();
    requestAnimationFrame(() => elements.galleryTitle.focus());
}

async function submitLogin(event) {
    event.preventDefault();
    const generation = beginAccessFlow();
    const submitButton = elements.loginForm.querySelector('button[type="submit"]');
    const password = elements.passwordInput.value;
    elements.passwordInput.value = '';
    elements.loginError.textContent = '';
    submitButton.disabled = true;
    elements.loginBack.disabled = true;

    try {
        const response = await fetch('/api/auth/login', {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ password }),
        });
        if (!response.ok) throw new Error('Authentication failed');
        if (!isCurrentAccessFlow(generation)) return;
        const manifest = await requestJson('/api/projects');
        if (!isCurrentAccessFlow(generation)) return;
        if (!manifest.authenticated) throw new Error('Session was not established');
        sessionStorage.setItem(ACCESS_MODE_KEY, 'interview');
        showGallery(manifest);
    } catch {
        if (!isCurrentAccessFlow(generation)) return;
        elements.loginError.textContent = '인증에 실패했습니다. 다시 확인해 주세요.';
        requestAnimationFrame(() => elements.passwordInput.focus());
    } finally {
        submitButton.disabled = false;
        elements.loginBack.disabled = false;
    }
}

async function relockPortfolio() {
    const generation = beginAccessFlow();
    let sessionCleared = false;
    elements.relockButton.disabled = true;
    closeViewer();
    elements.galleryError.hidden = true;
    elements.galleryError.textContent = '';
    try {
        const response = await fetch('/api/auth/logout', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { Accept: 'application/json' },
        });
        if (!response.ok) throw new Error('Logout failed');
        if (!isCurrentAccessFlow(generation)) return;
        sessionCleared = true;
        sessionStorage.setItem(ACCESS_MODE_KEY, 'public');
        const manifest = await requestJson('/api/projects?mode=public');
        if (!isCurrentAccessFlow(generation)) return;
        showGallery(manifest);
    } catch {
        if (!isCurrentAccessFlow(generation)) return;
        if (sessionCleared) {
            state.projects = [];
            state.currentProjectId = null;
            elements.galleryGrid.replaceChildren();
            elements.categoryTabs.replaceChildren();
            elements.galleryShell.hidden = true;
            elements.entrance.hidden = false;
            showEntranceChoices();
            elements.entranceStatus.textContent = '보호 콘텐츠는 잠겼지만 공개 포트폴리오를 불러오지 못했습니다. 다시 시도해 주세요.';
        } else {
            elements.galleryError.textContent = '다시 잠그지 못해 보호 콘텐츠 접근이 아직 활성화되어 있습니다. 다시 시도해 주세요.';
            elements.galleryError.hidden = false;
        }
    } finally {
        elements.relockButton.disabled = false;
    }
}

async function restoreSession() {
    const generation = state.accessFlowGeneration;
    const preferredMode = sessionStorage.getItem(ACCESS_MODE_KEY);
    const requestedMode = new URLSearchParams(window.location.search).get('mode');
    if (isStaticPublicSite()) {
        if (preferredMode === 'public' || requestedMode === 'public') await enterPublicPortfolio();
        return;
    }
    try {
        const session = await requestJson('/api/auth/session');
        if (!isCurrentAccessFlow(generation)) return;
        if (session.authenticated && preferredMode !== 'public') {
            const manifest = await requestJson('/api/projects');
            if (!isCurrentAccessFlow(generation)) return;
            if (manifest.authenticated) {
                sessionStorage.setItem(ACCESS_MODE_KEY, 'interview');
                showGallery(manifest);
                return;
            }
        }
        if (preferredMode === 'public' || requestedMode === 'public') {
            await enterPublicPortfolio();
        } else if (requestedMode === 'interview') {
            showLoginForm();
        }
    } catch {
        if (!isCurrentAccessFlow(generation)) return;
        sessionStorage.removeItem(ACCESS_MODE_KEY);
        if (requestedMode === 'interview') showLoginForm();
    }
}

function renderTabs() {
    elements.categoryTabs.replaceChildren();
    for (const project of state.projects) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'category-tab';
        button.textContent = project.title;
        button.setAttribute('aria-pressed', String(project.id === state.currentProjectId));
        if (project.locked) {
            button.setAttribute('aria-description', '잠김');
            const lock = document.createElement('span');
            lock.className = 'tab-lock';
            lock.setAttribute('aria-hidden', 'true');
            lock.textContent = '🔒';
            button.append(lock);
        }
        button.addEventListener('click', () => {
            state.currentProjectId = project.id;
            renderTabs();
            renderGallery();
        });
        elements.categoryTabs.append(button);
    }
}

function makeLockedCard(item, projectTitle, index) {
    const card = document.createElement('article');
    card.className = 'locked-card';
    card.dataset.locked = 'true';
    card.setAttribute('aria-disabled', 'true');
    card.setAttribute('aria-label', `${projectTitle} 비공개 작품 ${index + 1}, 잠김`);

    const art = document.createElement('div');
    art.className = 'locked-art';
    const copy = document.createElement('div');
    const mark = document.createElement('span');
    mark.className = 'lock-mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = '🔒';
    const title = document.createElement('strong');
    title.textContent = 'Interview Access Only';
    const description = document.createElement('small');
    description.textContent = '면접용 인증 후 열람 가능';
    copy.append(mark, title, description);
    art.append(copy);
    card.append(art);
    return card;
}

function makeArtworkCard(item, index) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'artwork-card';
    card.setAttribute('aria-label', `${item.title} 상세 보기`);
    card.addEventListener('click', () => openViewer(index, card));

    const frame = document.createElement('span');
    frame.className = 'artwork-frame';
    const media = document.createElement(item.type === 'video' ? 'video' : 'img');
    if (item.type === 'video') {
        media.muted = true;
        media.preload = 'none';
        media.playsInline = true;
        media.setAttribute('aria-hidden', 'true');
        if (item.poster) media.poster = item.poster;
    } else {
        media.alt = item.title;
        media.loading = 'lazy';
        media.decoding = 'async';
    }
    media.src = item.url;
    frame.append(media);

    const label = document.createElement('span');
    label.className = 'artwork-label';
    label.textContent = item.title;
    card.append(frame, label);
    return card;
}

function renderGallery() {
    const project = currentProject();
    elements.galleryGrid.replaceChildren();
    elements.artworkCount.textContent = String(project?.itemCount ?? 0);
    if (!project) return;
    project.items.forEach((item, index) => {
        elements.galleryGrid.append(
            item.locked ? makeLockedCard(item, project.title, index) : makeArtworkCard(item, index),
        );
    });
}

function cleanupViewerMedia() {
    elements.modalMedia.querySelectorAll('video, audio').forEach((media) => {
        media.pause();
        media.removeAttribute('src');
        media.load();
    });
    elements.modalMedia.replaceChildren();
}

function renderViewerItem() {
    const project = currentProject();
    const item = project?.items[state.currentItemIndex];
    if (!item || item.locked) return;
    cleanupViewerMedia();

    const media = document.createElement(item.type === 'video' ? 'video' : 'img');
    media.src = item.url;
    if (item.type === 'video') {
        media.controls = true;
        media.autoplay = true;
        media.playsInline = true;
        if (item.poster) media.poster = item.poster;
    } else {
        media.alt = item.title;
        media.draggable = false;
    }
    elements.modalMedia.append(media);
    elements.modalCategory.textContent = item.category;
    elements.modalTitle.textContent = item.title;
    elements.modalDescription.textContent = item.description ?? '';
    preloadAdjacent(project.items);
    showViewerInfo();
}

function preloadAdjacent(items) {
    if (items.length < 2) return;
    for (const offset of [-1, 1]) {
        const adjacent = items[(state.currentItemIndex + offset + items.length) % items.length];
        if (adjacent?.type === 'image' && !adjacent.locked) {
            const image = new Image();
            image.src = adjacent.url;
        }
    }
}

function openViewer(index, source) {
    const project = currentProject();
    if (!project || project.items[index]?.locked) return;
    state.lastFocusedElement = source;
    state.currentItemIndex = index;
    state.inertStates = [...document.body.children]
        .filter((element) => element !== elements.detailModal)
        .map((element) => ({ element, inert: element.inert }));
    state.inertStates.forEach(({ element }) => { element.inert = true; });
    renderViewerItem();
    elements.detailModal.hidden = false;
    document.body.classList.add('body-locked');
    elements.modalClose.focus();
}

function closeViewer() {
    if (elements.detailModal.hidden) return;
    cleanupViewerMedia();
    elements.detailModal.hidden = true;
    document.body.classList.remove('body-locked');
    state.inertStates.forEach(({ element, inert }) => { element.inert = inert; });
    state.inertStates = [];
    state.touchStartX = null;
    state.touchStartY = null;
    window.clearTimeout(state.viewerInfoTimer);
    state.lastFocusedElement?.focus();
}

function moveViewer(offset) {
    const items = currentProject()?.items ?? [];
    if (items.length === 0) return;
    state.currentItemIndex = (state.currentItemIndex + offset + items.length) % items.length;
    renderViewerItem();
}

function showViewerInfo() {
    elements.modalInfo.classList.remove('is-hidden');
    window.clearTimeout(state.viewerInfoTimer);
    state.viewerInfoTimer = window.setTimeout(() => {
        if (!elements.detailModal.hidden) elements.modalInfo.classList.add('is-hidden');
    }, 3000);
}

function trapFocus(container, event) {
    const controls = [...container.querySelectorAll('a[href], button, video[controls], [tabindex]:not([tabindex="-1"])')]
        .filter((element) => !element.disabled && element.getClientRects().length > 0);
    if (controls.length === 0) {
        event.preventDefault();
        return;
    }
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}

function openContact() {
    state.contactLastFocusedElement = document.activeElement;
    state.contactInertStates = [...document.body.children]
        .filter((element) => element !== elements.contactModal)
        .map((element) => ({ element, inert: element.inert }));
    state.contactInertStates.forEach(({ element }) => { element.inert = true; });
    elements.contactModal.hidden = false;
    document.body.classList.add('body-locked');
    requestAnimationFrame(() => elements.contactClose.focus());
}

function closeContact() {
    if (elements.contactModal.hidden) return;
    elements.contactModal.hidden = true;
    document.body.classList.remove('body-locked');
    state.contactInertStates.forEach(({ element, inert }) => { element.inert = inert; });
    state.contactInertStates = [];
    state.contactLastFocusedElement?.focus();
}

elements.interviewChoice.addEventListener('click', enterInterviewPortfolio);
elements.publicChoice.addEventListener('click', enterPublicPortfolio);
elements.loginBack.addEventListener('click', showEntranceChoices);
elements.loginForm.addEventListener('submit', submitLogin);
elements.relockButton.addEventListener('click', relockPortfolio);
elements.modalClose.addEventListener('click', closeViewer);
elements.previousButton.addEventListener('click', () => moveViewer(-1));
elements.nextButton.addEventListener('click', () => moveViewer(1));
elements.detailModal.addEventListener('pointermove', showViewerInfo);
elements.detailModal.addEventListener('touchstart', (event) => {
    state.touchStartX = null;
    state.touchStartY = null;
    showViewerInfo();
    if (event.touches.length !== 1) return;
    state.touchStartX = event.touches[0].clientX;
    state.touchStartY = event.touches[0].clientY;
}, { passive: true });
elements.detailModal.addEventListener('touchend', (event) => {
    const startX = state.touchStartX;
    const startY = state.touchStartY;
    state.touchStartX = null;
    state.touchStartY = null;
    if (startX === null || startY === null || event.changedTouches.length !== 1) return;
    const deltaX = event.changedTouches[0].clientX - startX;
    const deltaY = event.changedTouches[0].clientY - startY;
    if (Math.abs(deltaX) < 60 || Math.abs(deltaX) <= Math.abs(deltaY) * 1.2) return;
    moveViewer(deltaX < 0 ? 1 : -1);
}, { passive: true });
elements.detailModal.addEventListener('touchcancel', () => {
    state.touchStartX = null;
    state.touchStartY = null;
}, { passive: true });

document.addEventListener('keydown', (event) => {
    if (!elements.contactModal.hidden) {
        if (event.key === 'Tab') trapFocus(elements.contactModal, event);
        if (event.key === 'Escape') {
            event.preventDefault();
            closeContact();
        }
        return;
    }
    if (elements.detailModal.hidden) return;
    if (event.key === 'Tab') trapFocus(elements.detailModal, event);
    if (event.key === 'Escape') closeViewer();
    const isArrow = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
    const hasModifier = event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
    const mediaHasFocus = document.activeElement?.matches('video[controls], audio[controls]');
    if (isArrow && (hasModifier || mediaHasFocus)) return;
    if (isArrow) event.preventDefault();
    if (event.key === 'ArrowLeft') moveViewer(-1);
    if (event.key === 'ArrowRight') moveViewer(1);
});

elements.contactButton.addEventListener('click', openContact);
elements.contactClose.addEventListener('click', closeContact);

void restoreSession();
