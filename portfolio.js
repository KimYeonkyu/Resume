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
    localAccessFlowGeneration: 0,
    currentSessionIntent: null,
    sessionIntentStorageFallback: false,
    handledSessionIntentIds: new Set(),
};

const ACCESS_MODE_KEY = 'portfolio-access-mode';
const SESSION_MUTATION_LOCK = 'jin-kim-portfolio-session-mutation';
const SESSION_MUTATION_TIMEOUT_MS = 10_000;
const SESSION_LOCK_WAIT_TIMEOUT_MS = 30_000;
const SESSION_INTENT_STORAGE_KEY = 'jin-kim-portfolio-session-intent';
const SESSION_INTENT_CHANNEL_NAME = 'jin-kim-portfolio-session-intent';
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

const sessionIntentChannel = typeof BroadcastChannel === 'function'
    ? new BroadcastChannel(SESSION_INTENT_CHANNEL_NAME)
    : null;

function currentProject() {
    return state.projects.find((project) => project.id === state.currentProjectId) ?? null;
}

function beginAccessFlow({ local = true } = {}) {
    state.accessFlowGeneration += 1;
    if (local) state.localAccessFlowGeneration += 1;
    return state.accessFlowGeneration;
}

function isCurrentAccessFlow(generation) {
    return state.accessFlowGeneration === generation;
}

function rememberSessionIntent(intentId) {
    if (state.handledSessionIntentIds.has(intentId)) return false;
    state.handledSessionIntentIds.add(intentId);
    if (state.handledSessionIntentIds.size > 64) {
        state.handledSessionIntentIds.delete(state.handledSessionIntentIds.values().next().value);
    }
    return true;
}

function isSessionIntent(value) {
    if (
        !value
        || typeof value !== 'object'
        || (value.kind !== 'login' && value.kind !== 'logout')
        || typeof value.id !== 'string'
        || !/^[a-f0-9-]{16,64}$/.test(value.id)
    ) return false;
    if (value.kind === 'logout') return true;
    return value.logoutIntentId === null
        || (
            typeof value.logoutIntentId === 'string'
            && /^[a-f0-9-]{16,64}$/.test(value.logoutIntentId)
        );
}

function readPersistedSessionIntent() {
    try {
        const raw = localStorage.getItem(SESSION_INTENT_STORAGE_KEY);
        if (!raw || raw.length > 256) return null;
        const parsed = JSON.parse(raw);
        return isSessionIntent(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function currentSessionIntent() {
    if (state.sessionIntentStorageFallback) return state.currentSessionIntent;
    return readPersistedSessionIntent() ?? state.currentSessionIntent;
}

function latestLogoutIntentId() {
    const intent = currentSessionIntent();
    if (intent?.kind === 'logout') return intent.id;
    return intent?.kind === 'login' ? intent.logoutIntentId : null;
}

function hasActiveLogoutIntent() {
    return currentSessionIntent()?.kind === 'logout';
}

function makeSessionIntentId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    if (typeof crypto.getRandomValues !== 'function') {
        throw new Error('Secure session coordination is unavailable');
    }
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function readAccessMode() {
    try {
        return sessionStorage.getItem(ACCESS_MODE_KEY);
    } catch {
        return null;
    }
}

function writeAccessMode(mode) {
    try {
        sessionStorage.setItem(ACCESS_MODE_KEY, mode);
    } catch {
        // In-memory generation and DOM purging remain fail-closed.
    }
}

function clearAccessMode() {
    try {
        sessionStorage.removeItem(ACCESS_MODE_KEY);
    } catch {
        // No persisted mode is required for the current document.
    }
}

function persistSessionIntent(intent) {
    state.currentSessionIntent = intent;
    try {
        localStorage.setItem(SESSION_INTENT_STORAGE_KEY, JSON.stringify(intent));
        state.sessionIntentStorageFallback = false;
        return true;
    } catch {
        state.sessionIntentStorageFallback = true;
        return false;
    }
}

function broadcastSessionIntent(intent, persisted) {
    try {
        sessionIntentChannel?.postMessage({ intent, persisted });
    } catch {
        // A persisted storage event remains available when BroadcastChannel fails.
    }
}

function commitSessionIntent(intent) {
    rememberSessionIntent(intent.id);
    const persisted = persistSessionIntent(intent);
    broadcastSessionIntent(intent, persisted);
}

function applyRemoteSessionIntent(intent, requirePersistedMatch = true) {
    if (!isSessionIntent(intent)) return;
    if (requirePersistedMatch) {
        const persisted = readPersistedSessionIntent();
        if (!persisted || persisted.kind !== intent.kind || persisted.id !== intent.id) return;
    }
    if (!rememberSessionIntent(intent.id)) return;
    state.currentSessionIntent = intent;
    state.sessionIntentStorageFallback = !requirePersistedMatch;
    if (intent.kind === 'login') return;
    beginAccessFlow({ local: false });
    writeAccessMode('public');
    discardProtectedGallery();
    elements.entranceStatus.textContent = '다른 창의 요청으로 보호 콘텐츠를 화면에서 제거했습니다.';
}

function publishLogoutIntent(intent) {
    writeAccessMode('public');
    discardProtectedGallery();
    elements.entranceStatus.textContent = '보호 콘텐츠를 화면에서 제거하고 서버 잠금을 처리 중입니다.';
    commitSessionIntent(intent);
}

sessionIntentChannel?.addEventListener('message', (event) => {
    const envelope = event.data;
    if (!envelope || typeof envelope !== 'object' || !('intent' in envelope)) return;
    applyRemoteSessionIntent(envelope.intent, envelope.persisted !== false);
});

window.addEventListener('storage', (event) => {
    if (event.key !== SESSION_INTENT_STORAGE_KEY || !event.newValue) return;
    try {
        applyRemoteSessionIntent(JSON.parse(event.newValue));
    } catch {
        // Ignore malformed same-origin coordination messages.
    }
});

async function mutateSession(
    url,
    options,
    { onLockAcquired = () => {}, onResponse = () => {} } = {},
) {
    if (!navigator.locks?.request || typeof AbortController !== 'function') {
        throw new Error('Origin-wide session locking is unavailable');
    }

    const lockController = new AbortController();
    const lockTimer = window.setTimeout(() => {
        lockController.abort(new DOMException('Session lock timed out', 'TimeoutError'));
    }, SESSION_LOCK_WAIT_TIMEOUT_MS);

    try {
        return await navigator.locks.request(
            SESSION_MUTATION_LOCK,
            { mode: 'exclusive', signal: lockController.signal },
            async () => {
                window.clearTimeout(lockTimer);
                onLockAcquired();
                const requestController = new AbortController();
                const requestTimer = window.setTimeout(() => {
                    requestController.abort(new DOMException('Session mutation timed out', 'TimeoutError'));
                }, SESSION_MUTATION_TIMEOUT_MS);
                try {
                    const response = await fetch(url, {
                        credentials: 'same-origin',
                        ...options,
                        signal: requestController.signal,
                    });
                    await onResponse(response);
                    return response;
                } finally {
                    window.clearTimeout(requestTimer);
                }
            },
        );
    } finally {
        window.clearTimeout(lockTimer);
    }
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

function renderEntranceChoices() {
    elements.loginForm.hidden = true;
    elements.entranceActions.hidden = false;
    elements.passwordInput.value = '';
    elements.loginError.textContent = '';
    requestAnimationFrame(() => elements.interviewChoice.focus());
}

function showEntranceChoices() {
    beginAccessFlow();
    renderEntranceChoices();
}

async function enterPublicPortfolio() {
    const generation = beginAccessFlow();
    writeAccessMode('public');
    elements.publicChoice.disabled = true;
    elements.entranceStatus.textContent = '';
    try {
        let manifest;
        if (isStaticPublicSite()) {
            manifest = await requestJson('./public-portfolio-manifest.json', { cache: 'no-store' });
        } else {
            const logoutIntent = { kind: 'logout', id: makeSessionIntentId() };
            publishLogoutIntent(logoutIntent);
            const logoutMutation = mutateSession(
                '/api/auth/logout',
                {
                    method: 'POST',
                    headers: { Accept: 'application/json' },
                },
                { onLockAcquired: () => commitSessionIntent(logoutIntent) },
            );
            const logoutResponse = await logoutMutation;
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

function discardProtectedGallery() {
    if (elements.detailModal.hidden) cleanupViewerMedia();
    else closeViewer();
    state.projects = [];
    state.currentProjectId = null;
    state.currentItemIndex = 0;
    elements.galleryGrid.replaceChildren();
    elements.categoryTabs.replaceChildren();
    elements.modalCategory.textContent = '';
    elements.modalTitle.textContent = '';
    elements.modalDescription.textContent = '';
    elements.artworkCount.textContent = '0';
    elements.relockButton.hidden = true;
    elements.galleryShell.hidden = true;
    elements.entrance.hidden = false;
    renderEntranceChoices();
}

async function submitLogin(event) {
    event.preventDefault();
    let generation = beginAccessFlow();
    const localGeneration = state.localAccessFlowGeneration;
    const logoutIntentAtSubmission = latestLogoutIntentId();
    const loginIntent = {
        kind: 'login',
        id: makeSessionIntentId(),
        logoutIntentId: logoutIntentAtSubmission,
    };
    let loginBarrierCommitted = false;
    const submitButton = elements.loginForm.querySelector('button[type="submit"]');
    const password = elements.passwordInput.value;
    elements.passwordInput.value = '';
    elements.loginError.textContent = '';
    submitButton.disabled = true;
    elements.loginBack.disabled = true;

    try {
        const response = await mutateSession(
            '/api/auth/login',
            {
                method: 'POST',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ password }),
            },
            {
                onLockAcquired: () => {
                    if (latestLogoutIntentId() !== logoutIntentAtSubmission) {
                        throw new Error('Login was superseded by a logout request');
                    }
                },
                onResponse: (loginResponse) => {
                    if (
                        loginResponse.ok
                        && state.localAccessFlowGeneration === localGeneration
                        && latestLogoutIntentId() === logoutIntentAtSubmission
                    ) {
                        commitSessionIntent(loginIntent);
                        loginBarrierCommitted = true;
                    }
                },
            },
        );
        if (!response.ok) throw new Error('Authentication failed');
        if (
            !loginBarrierCommitted
            || state.localAccessFlowGeneration !== localGeneration
            || latestLogoutIntentId() !== logoutIntentAtSubmission
        ) return;
        generation = beginAccessFlow({ local: false });
        const manifest = await requestJson('/api/projects');
        if (
            !isCurrentAccessFlow(generation)
            || state.localAccessFlowGeneration !== localGeneration
            || latestLogoutIntentId() !== logoutIntentAtSubmission
        ) return;
        if (!manifest.authenticated) throw new Error('Session was not established');
        writeAccessMode('interview');
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
        const logoutIntent = { kind: 'logout', id: makeSessionIntentId() };
        publishLogoutIntent(logoutIntent);
        const logoutMutation = mutateSession(
            '/api/auth/logout',
            {
                method: 'POST',
                headers: { Accept: 'application/json' },
            },
            { onLockAcquired: () => commitSessionIntent(logoutIntent) },
        );
        const response = await logoutMutation;
        if (!response.ok) throw new Error('Logout failed');
        if (!isCurrentAccessFlow(generation)) return;
        sessionCleared = true;
        writeAccessMode('public');
        discardProtectedGallery();
        const manifest = await requestJson('/api/projects?mode=public');
        if (!isCurrentAccessFlow(generation)) return;
        showGallery(manifest);
    } catch {
        if (!isCurrentAccessFlow(generation)) return;
        if (sessionCleared) {
            discardProtectedGallery();
            showEntranceChoices();
            elements.entranceStatus.textContent = '보호 콘텐츠는 잠겼지만 공개 포트폴리오를 불러오지 못했습니다. 다시 시도해 주세요.';
        } else {
            elements.entranceStatus.textContent = '다시 잠그지 못해 서버 접근이 아직 활성화되어 있습니다. 공개 포트폴리오를 눌러 다시 시도해 주세요.';
        }
    } finally {
        elements.relockButton.disabled = false;
    }
}

async function restoreSession() {
    const generation = state.accessFlowGeneration;
    const logoutIntentAtStart = latestLogoutIntentId();
    const preferredMode = hasActiveLogoutIntent()
        ? 'public'
        : readAccessMode();
    const requestedMode = new URLSearchParams(window.location.search).get('mode');
    if (isStaticPublicSite()) {
        if (preferredMode === 'public' || requestedMode === 'public') await enterPublicPortfolio();
        return;
    }
    try {
        const session = await requestJson('/api/auth/session');
        if (
            !isCurrentAccessFlow(generation)
            || latestLogoutIntentId() !== logoutIntentAtStart
        ) return;
        if (session.authenticated && preferredMode !== 'public') {
            const manifest = await requestJson('/api/projects');
            if (
                !isCurrentAccessFlow(generation)
                || latestLogoutIntentId() !== logoutIntentAtStart
            ) return;
            if (manifest.authenticated) {
                writeAccessMode('interview');
                showGallery(manifest);
                return;
            }
        }
        if (requestedMode === 'interview') {
            showLoginForm();
        } else if (preferredMode === 'public' || requestedMode === 'public') {
            await enterPublicPortfolio();
        }
    } catch {
        if (!isCurrentAccessFlow(generation)) return;
        clearAccessMode();
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

function handleEntranceClick(event) {
    if (elements.entranceActions.hidden || elements.publicChoice.disabled) return;
    if (event.target.closest('#public-choice, #interview-choice, #login-form')) return;
    void enterPublicPortfolio();
}

elements.entrance.addEventListener('click', handleEntranceClick);
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
