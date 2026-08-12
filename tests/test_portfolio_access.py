# pyright: reportMissingImports=false
from __future__ import annotations

import functools
import hashlib
import hmac
import json
import secrets
import threading
from collections.abc import Iterator
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

import pytest
from playwright.sync_api import Page, Route, expect, sync_playwright


REPO_ROOT = Path(__file__).resolve().parents[1]
STATIC_ROOT = REPO_ROOT / "dist"
PORTFOLIO_PATH = "/jin_kim_portfolio.html"
SESSION_MUTATION_LOCK = "jin-kim-portfolio-session-mutation"
SESSION_MUTATION_TIMEOUT_MS = 10_000
SESSION_LOCK_WAIT_TIMEOUT_MS = 30_000
SESSION_INTENT_STORAGE_KEY = "jin-kim-portfolio-session-intent"
SESSION_INTENT_CHANNEL_NAME = "jin-kim-portfolio-session-intent"


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        pass


@pytest.fixture(scope="module")
def portfolio_url() -> Iterator[str]:
    assert STATIC_ROOT.is_dir(), "Run npm run build before browser tests"
    handler = functools.partial(QuietHandler, directory=str(STATIC_ROOT))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        host = str(server.server_address[0])
        port = int(server.server_address[1])
        yield f"http://{host}:{port}{PORTFOLIO_PATH}"
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()


@pytest.fixture()
def page() -> Iterator[Page]:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1280, "height": 900})
        page = context.new_page()
        yield page
        context.close()
        browser.close()


def install_static_github_pages(page: Page) -> list[str]:
    requests: list[str] = []
    root = STATIC_ROOT.resolve()
    content_types = {
        ".css": "text/css; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".jpg": "image/jpeg",
        ".webp": "image/webp",
        ".mp4": "video/mp4",
        ".pdf": "application/pdf",
    }

    def route_static(route: Route) -> None:
        requests.append(route.request.url)
        parsed = urlsplit(route.request.url)
        prefix = "/Resume/"
        if not parsed.path.startswith(prefix):
            route.fulfill(status=404, body="")
            return
        relative = unquote(parsed.path[len(prefix) :]) or "index.html"
        candidate = (root / relative).resolve()
        if not candidate.is_relative_to(root) or not candidate.is_file():
            route.fulfill(status=404, body="")
            return
        route.fulfill(
            status=200,
            body=candidate.read_bytes(),
            content_type=content_types.get(candidate.suffix.lower(), "application/octet-stream"),
        )

    page.route("https://kimyeonkyu.github.io/Resume/**", route_static)
    return requests


def guest_manifest() -> dict[str, object]:
    projects: list[dict[str, object]] = [
        {
            "id": "personal",
            "title": "개인작",
            "protected": False,
            "locked": False,
            "itemCount": 1,
            "items": [
                {
                    "id": "personal-01",
                    "title": "1",
                    "category": "개인작",
                    "type": "image",
                    "description": "개인작 · 1",
                    "url": "/%EA%B0%9C%EC%9D%B8%EC%9E%91/1.jpg",
                }
            ],
        }
    ]
    for project_id, title, count in (
        ("project-mp", "Project MP", 6),
        ("project-dm", "Project DM", 18),
    ):
        projects.append(
            {
                "id": project_id,
                "title": title,
                "protected": True,
                "locked": True,
                "itemCount": count,
                "items": [
                    {
                        "id": f"locked-{project_id}-{index}",
                        "title": "비공개 작품",
                        "type": "locked",
                        "locked": True,
                    }
                    for index in range(1, count + 1)
                ],
            }
        )
    return {"authenticated": False, "projects": projects}


def install_guest_api(page: Page) -> list[str]:
    protected_requests: list[str] = []

    def route_api(route: Route) -> None:
        path = route.request.url.split("?", 1)[0]
        if path.endswith("/api/auth/session"):
            route.fulfill(status=200, json={"authenticated": False})
        elif path.endswith("/api/auth/logout"):
            route.fulfill(status=204)
        elif path.endswith("/api/projects"):
            route.fulfill(status=200, json=guest_manifest())
        else:
            route.fulfill(status=404, json={"error": "Not found"})

    page.route("**/api/**", route_api)
    page.on(
        "request",
        lambda request: protected_requests.append(request.url)
        if "/protected/" in request.url
        else None,
    )
    return protected_requests


def authenticated_manifest(protected_urls: dict[str, list[str]]) -> dict[str, object]:
    projects = list(guest_manifest()["projects"])
    projects = [project for project in projects if not project["protected"]]
    for project_id, title in (("project-mp", "Project MP"), ("project-dm", "Project DM")):
        urls = protected_urls[project_id]
        projects.append(
            {
                "id": project_id,
                "title": title,
                "protected": True,
                "locked": False,
                "itemCount": len(urls),
                "items": [
                    {
                        "id": f"{project_id}-display-{index}",
                        "title": f"{title} · {index:02d}",
                        "category": title,
                        "type": "image",
                        "description": f"{title} · 보호된 작품",
                        "url": url,
                    }
                    for index, url in enumerate(urls, start=1)
                ],
            }
        )
    return {"authenticated": True, "projects": projects}


def install_interview_api(
    page: Page,
    configured_password: str,
    *,
    logout_status: int = 204,
    abort_logout: bool = False,
    defer_logout: bool = False,
    defer_login: bool = False,
    defer_public_projects: bool = False,
) -> dict[str, object]:
    session_value = secrets.token_hex(24)
    protected_urls = {
        "project-mp": [f"/protected/{secrets.token_hex(10)}" for _ in range(6)],
        "project-dm": [f"/protected/{secrets.token_hex(10)}" for _ in range(18)],
    }
    all_protected_urls = {
        url for project_urls in protected_urls.values() for url in project_urls
    }
    calls: dict[str, object] = {
        "login": 0,
        "logout": 0,
        "projects_authenticated": 0,
        "projects_public": 0,
        "protected": [],
        "protected_urls": protected_urls,
        "session_value": session_value,
        "pending_logout": [],
        "pending_login": [],
        "pending_public_projects": [],
    }

    def has_session(route: Route) -> bool:
        cookie = route.request.headers.get("cookie", "")
        return hmac.compare_digest(cookie, f"browser_session={session_value}")

    def route_api(route: Route) -> None:
        request = route.request
        path = request.url.split("?", 1)[0]
        if path.endswith("/api/auth/session"):
            route.fulfill(status=200, json={"authenticated": has_session(route)})
            return
        if path.endswith("/api/auth/login"):
            calls["login"] = int(calls["login"]) + 1
            try:
                supplied = json.loads(request.post_data or "").get("password", "")
            except (json.JSONDecodeError, AttributeError):
                supplied = ""
            if hmac.compare_digest(supplied, configured_password):
                if defer_login:
                    pending_login = calls["pending_login"]
                    assert isinstance(pending_login, list)
                    pending_login.append(route)
                    return
                route.fulfill(
                    status=204,
                    headers={
                        "Set-Cookie": f"browser_session={session_value}; Path=/; SameSite=Strict"
                    },
                )
            else:
                route.fulfill(status=401, json={"error": "Authentication failed"})
            return
        if path.endswith("/api/auth/logout"):
            calls["logout"] = int(calls["logout"]) + 1
            if abort_logout:
                route.abort("failed")
                return
            if defer_logout:
                pending_logout = calls["pending_logout"]
                assert isinstance(pending_logout, list)
                pending_logout.append(route)
                return
            if logout_status == 204:
                route.fulfill(
                    status=204,
                    headers={
                        "Set-Cookie": "browser_session=; Max-Age=0; Path=/; SameSite=Strict"
                    },
                )
            else:
                route.fulfill(status=logout_status, json={"error": "Synthetic logout failure"})
            return
        if path.endswith("/api/projects"):
            force_public = "mode=public" in request.url
            counter = "projects_public" if force_public else "projects_authenticated"
            calls[counter] = int(calls[counter]) + 1
            if force_public and defer_public_projects:
                pending_public_projects = calls["pending_public_projects"]
                assert isinstance(pending_public_projects, list)
                pending_public_projects.append(route)
                return
            manifest = (
                authenticated_manifest(protected_urls)
                if has_session(route) and not force_public
                else guest_manifest()
            )
            route.fulfill(status=200, json=manifest)
            return
        route.fulfill(status=404, json={"error": "Not found"})

    def route_protected(route: Route) -> None:
        path = "/" + route.request.url.split("/", 3)[-1]
        cast_requests = calls["protected"]
        assert isinstance(cast_requests, list)
        cast_requests.append(path)
        if path not in all_protected_urls or not has_session(route):
            route.fulfill(status=401, body="")
            return
        route.fulfill(
            status=200,
            content_type="image/svg+xml",
            body=(
                '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="20">'
                '<rect width="32" height="20" fill="#222"/></svg>'
            ),
        )

    page.context.route("**/api/**", route_api)
    page.context.route("**/protected/**", route_protected)
    return calls


def wait_for_pending_session_lock(page: Page, expected_path: str) -> None:
    lock_state = {"lockName": SESSION_MUTATION_LOCK, "path": expected_path}
    page.wait_for_function(
        """async ({ lockName, path }) => {
            const snapshot = await navigator.locks.query();
            return snapshot.pending.some(lock => lock.name === lockName)
                && !window.__sessionMutationFetches.includes(path);
        }""",
        arg=lock_state,
    )
    state = page.evaluate(
        """async ({ lockName, path }) => {
            const snapshot = await navigator.locks.query();
            return {
                pending: snapshot.pending.some(lock => lock.name === lockName),
                invoked: window.__sessionMutationFetches.includes(path),
            };
        }""",
        lock_state,
    )
    assert state == {"pending": True, "invoked": False}


def wait_for_held_session_lock(page: Page, expected_path: str) -> None:
    lock_state = {"lockName": SESSION_MUTATION_LOCK, "path": expected_path}
    page.wait_for_function(
        """async ({ lockName, path }) => {
            const snapshot = await navigator.locks.query();
            return snapshot.held.some(lock => lock.name === lockName)
                && window.__sessionMutationFetches.includes(path);
        }""",
        arg=lock_state,
    )


def install_session_mutation_probe(page: Page) -> None:
    page.add_init_script(
        """(() => {
            const originalFetch = window.fetch.bind(window);
            window.__sessionMutationFetches = [];
            window.fetch = (input, options) => {
                const url = new URL(typeof input === 'string' ? input : input.url, location.href);
                if (url.pathname === '/api/auth/login' || url.pathname === '/api/auth/logout') {
                    window.__sessionMutationFetches.push(url.pathname);
                }
                return originalFetch(input, options);
            };
        })();"""
    )


def test_static_github_pages_uses_relative_assets_and_guest_manifest_only(page: Page) -> None:
    requests = install_static_github_pages(page)
    page.add_init_script(
        """
        const nativeFetch = window.fetch.bind(window);
        window.__portfolioFetchCalls = [];
        window.fetch = (input, options = {}) => {
            window.__portfolioFetchCalls.push({ url: String(input), cache: options.cache ?? null });
            return nativeFetch(input, options);
        };
        """
    )
    page.goto(
        "https://kimyeonkyu.github.io/Resume/jin_kim_portfolio.html",
        wait_until="domcontentloaded",
    )

    page.get_by_role("button", name="공개 포트폴리오", exact=True).press("Enter")
    page.locator("#gallery-shell").wait_for(state="visible")

    for title, locked_count in (("워헤이븐", 10), ("Project MP", 5), ("Project DM", 18)):
        page.get_by_role("button", name=title, exact=True).click()
        assert page.locator('#gallery-grid [data-locked="true"]').count() == locked_count

    page.get_by_role("button", name="개인작", exact=True).click()
    personal_16 = urlsplit(
        page.locator("#gallery-grid img").nth(15).evaluate("image => image.src")
    )
    assert unquote(personal_16.path) == "/Resume/개인작/16.jpg"
    assert personal_16.query == (
        "v=" + hashlib.sha256((REPO_ROOT / "개인작" / "16.jpg").read_bytes()).hexdigest()
    )

    assert any("/Resume/portfolio.css" in url for url in requests)
    assert any("/Resume/portfolio.js" in url for url in requests)
    assert any("/Resume/public-portfolio-manifest.json" in url for url in requests)
    manifest_fetch = page.evaluate(
        """() => window.__portfolioFetchCalls.find(
            call => call.url === './public-portfolio-manifest.json'
        )"""
    )
    assert manifest_fetch == {
        "url": "./public-portfolio-manifest.json",
        "cache": "no-store",
    }
    assert all("/api/" not in url and "/protected/" not in url for url in requests)
    assert page.locator('[src*="/protected/"], [poster*="/protected/"]').count() == 0


def test_static_github_pages_interview_choice_uses_mac_mini_https(page: Page) -> None:
    requests = install_static_github_pages(page)
    destination = "https://minionion.duckdns.org/jin_kim_portfolio.html?mode=interview"
    page.route(
        "https://minionion.duckdns.org/**",
        lambda route: route.fulfill(status=200, content_type="text/html", body="<!doctype html><title>Interview</title>"),
    )
    page.goto(
        "https://kimyeonkyu.github.io/Resume/jin_kim_portfolio.html",
        wait_until="domcontentloaded",
    )

    with page.expect_navigation(wait_until="domcontentloaded"):
        page.get_by_role("button", name="면접용 전체 포트폴리오", exact=True).click()

    assert page.url == destination
    assert all("/api/" not in url and "/protected/" not in url for url in requests)


def test_entrance_uses_full_width_attached_artwork_and_exact_identity(
    page: Page, portfolio_url: str
) -> None:
    install_guest_api(page)

    page.goto(portfolio_url, wait_until="domcontentloaded")

    image = page.locator("#portfolio-cover")
    assert image.count() == 1
    page.wait_for_function(
        "document.querySelector('#portfolio-cover')?.complete === true"
    )
    assert image.evaluate("element => [element.naturalWidth, element.naturalHeight]") == [
        3808,
        1087,
    ]
    assert image.get_attribute("src") == "./jin-kim-cover.webp"
    assert page.get_by_role("heading", name="JIN KIM", exact=True).is_visible()
    assert page.get_by_text("Environment concept artist", exact=True).is_visible()

    viewport = page.viewport_size
    image_box = image.bounding_box()
    assert viewport is not None and image_box is not None
    assert abs(image_box["width"] - viewport["width"]) <= 1
    assert page.evaluate(
        "document.documentElement.scrollWidth <= document.documentElement.clientWidth"
    )

    key_button = page.get_by_role(
        "button", name="면접용 전체 포트폴리오", exact=True
    )
    assert key_button.is_visible()
    assert key_button.locator("svg").count() == 1
    key_box = key_button.bounding_box()
    icon_box = key_button.locator("svg").bounding_box()
    assert key_box is not None and icon_box is not None
    assert key_box["y"] > viewport["height"] * 0.8
    assert icon_box["width"] <= 16

    contrast = key_button.evaluate(
        """
        element => {
            const style = getComputedStyle(element);
            const parse = value => {
                const parts = value.match(/[\\d.]+/g).map(Number);
                return { rgb: parts.slice(0, 3), alpha: parts[3] ?? 1 };
            };
            const blend = (foreground, backdrop, alpha) => foreground.map(
                (channel, index) => channel * alpha + backdrop[index] * (1 - alpha)
            );
            const luminance = rgb => {
                const linear = rgb.map(channel => {
                    const value = channel / 255;
                    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
                });
                return .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
            };
            const ratio = (foreground, backdrop) => {
                const lighter = Math.max(luminance(foreground), luminance(backdrop));
                const darker = Math.min(luminance(foreground), luminance(backdrop));
                return (lighter + .05) / (darker + .05);
            };
            const background = parse(style.backgroundColor);
            const backdrop = background.rgb;
            const opacity = Number(style.opacity);
            const effective = value => {
                const color = parse(value);
                return blend(blend(color.rgb, backdrop, color.alpha), backdrop, opacity);
            };
            return {
                backgroundAlpha: background.alpha,
                opacity,
                icon: ratio(effective(style.color), backdrop),
                border: ratio(effective(style.borderTopColor), backdrop),
            };
        }
        """
    )
    assert contrast["backgroundAlpha"] == 1
    assert contrast["opacity"] == 1
    assert contrast["icon"] >= 3
    assert contrast["border"] >= 3

    assert page.get_by_role("button", name="공개 포트폴리오", exact=True).is_visible()
    assert page.locator("#gallery-shell").is_hidden()


@pytest.mark.parametrize("viewport", [(1920, 500), (1024, 300)])
def test_short_entrance_keeps_full_artwork_and_identity_reachable(
    page: Page, portfolio_url: str, viewport: tuple[int, int]
) -> None:
    width, height = viewport
    page.set_viewport_size({"width": width, "height": height})
    install_guest_api(page)
    page.goto(portfolio_url, wait_until="domcontentloaded")

    entrance = page.locator("#entrance-screen")
    image = page.locator("#portfolio-cover")
    subtitle = page.get_by_text("Environment concept artist", exact=True)
    page.wait_for_function(
        "document.querySelector('#portfolio-cover')?.complete === true"
    )

    image_box = image.bounding_box()
    assert image_box is not None
    assert abs(image_box["width"] - width) <= 1
    assert image_box["y"] >= -1
    assert entrance.evaluate("element => element.scrollHeight > element.clientHeight")

    page.mouse.move(width / 2, height / 2)
    page.mouse.wheel(0, height)
    page.wait_for_function(
        "document.querySelector('#entrance-screen').scrollTop > 0"
    )
    subtitle_box = subtitle.bounding_box()
    assert subtitle_box is not None
    assert subtitle_box["y"] >= 0
    assert subtitle_box["y"] + subtitle_box["height"] <= height

    page.mouse.click(width / 2, height / 2)
    page.locator("#gallery-shell").wait_for(state="visible")
    assert page.locator("#access-status").text_content() == "공개 보기"


def test_short_entrance_supports_real_touch_swipe(
    page: Page, portfolio_url: str
) -> None:
    width, height = 1024, 300
    page.set_viewport_size({"width": width, "height": height})
    install_guest_api(page)
    page.goto(portfolio_url, wait_until="domcontentloaded")

    entrance = page.locator("#entrance-screen")
    subtitle = page.get_by_text("Environment concept artist", exact=True)
    assert entrance.evaluate("element => element.scrollTop") == 0
    assert entrance.evaluate("element => element.scrollHeight > element.clientHeight")

    cdp = page.context.new_cdp_session(page)
    cdp.send(
        "Emulation.setTouchEmulationEnabled",
        {"enabled": True, "maxTouchPoints": 1},
    )
    x = width // 2
    start_y = height - 35
    cdp.send(
        "Input.dispatchTouchEvent",
        {
            "type": "touchStart",
            "touchPoints": [{"x": x, "y": start_y}],
        },
    )
    for y in range(start_y - 30, 40, -30):
        cdp.send(
            "Input.dispatchTouchEvent",
            {
                "type": "touchMove",
                "touchPoints": [{"x": x, "y": y}],
            },
        )
        page.wait_for_timeout(16)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})

    page.wait_for_function(
        "document.querySelector('#entrance-screen').scrollTop > 0"
    )
    subtitle_box = subtitle.bounding_box()
    assert subtitle_box is not None
    assert subtitle_box["y"] >= 0
    assert subtitle_box["y"] + subtitle_box["height"] <= height


def test_clicking_anywhere_on_cover_enters_public_portfolio(
    page: Page, portfolio_url: str
) -> None:
    install_guest_api(page)
    page.goto(portfolio_url, wait_until="domcontentloaded")

    public_hit_area = page.get_by_role("button", name="공개 포트폴리오", exact=True)
    viewport = page.viewport_size
    hit_box = public_hit_area.bounding_box()
    assert viewport is not None and hit_box is not None
    assert hit_box["x"] == 0
    assert hit_box["y"] == 0
    assert abs(hit_box["width"] - viewport["width"]) <= 1
    assert abs(hit_box["height"] - viewport["height"]) <= 1

    page.mouse.click(20, 20)
    page.locator("#gallery-shell").wait_for(state="visible")
    assert page.locator("#access-status").text_content() == "공개 보기"


def test_small_key_opens_interview_password_form_without_entering_public_gallery(
    page: Page, portfolio_url: str
) -> None:
    install_guest_api(page)
    page.goto(portfolio_url, wait_until="domcontentloaded")

    page.get_by_role("button", name="면접용 전체 포트폴리오", exact=True).click()
    form = page.get_by_role("form", name="면접용 포트폴리오 로그인")
    assert form.is_visible()
    assert form.get_by_label("비밀번호").get_attribute("type") == "password"
    assert page.locator("#gallery-shell").is_hidden()

    page.mouse.click(20, 20)
    assert form.is_visible()
    assert page.locator("#gallery-shell").is_hidden()


def test_entrance_controls_support_tab_shift_tab_enter_and_space(
    page: Page, portfolio_url: str
) -> None:
    install_guest_api(page)
    page.goto(portfolio_url, wait_until="domcontentloaded")

    public_choice = page.get_by_role(
        "button", name="공개 포트폴리오", exact=True
    )
    interview_choice = page.get_by_role(
        "button", name="면접용 전체 포트폴리오", exact=True
    )

    page.keyboard.press("Tab")
    expect(public_choice).to_be_focused()
    page.keyboard.press("Tab")
    expect(interview_choice).to_be_focused()
    page.keyboard.press("Enter")

    form = page.get_by_role("form", name="면접용 포트폴리오 로그인")
    assert form.is_visible()
    expect(form.get_by_label("비밀번호")).to_be_focused()

    page.get_by_role("button", name="선택으로 돌아가기", exact=True).click()
    expect(interview_choice).to_be_focused()
    page.keyboard.press("Shift+Tab")
    expect(public_choice).to_be_focused()
    page.keyboard.press("Space")

    page.locator("#gallery-shell").wait_for(state="visible")
    expect(page.get_by_role("heading", name="Jin Kim Portfolio", exact=True)).to_be_focused()


def test_interview_query_opens_login_form_on_protected_origin(
    page: Page, portfolio_url: str
) -> None:
    install_guest_api(page)
    page.goto(f"{portfolio_url}?mode=interview", wait_until="domcontentloaded")
    form = page.get_by_role("form", name="면접용 포트폴리오 로그인")
    form.wait_for(state="visible")
    expect(form.get_by_label("비밀번호")).to_be_focused()


def test_guest_protected_categories_are_dark_locked_and_request_no_media(
    page: Page, portfolio_url: str
) -> None:
    protected_requests = install_guest_api(page)
    page.goto(portfolio_url, wait_until="domcontentloaded")

    page.get_by_role("button", name="공개 포트폴리오", exact=True).press("Enter")
    page.locator("#gallery-shell").wait_for(state="visible")

    for title, count in (("Project MP", 6), ("Project DM", 18)):
        page.get_by_role("button", name=title, exact=True).click()
        cards = page.locator('#gallery-grid [data-locked="true"]')
        assert cards.count() == count
        assert all(card.get_attribute("aria-disabled") == "true" for card in cards.all())
        assert page.get_by_role("button", name=title, exact=True).get_attribute(
            "aria-description"
        ) == "잠김"
        assert title in (cards.first.get_attribute("aria-label") or "")
        assert cards.first.get_by_text("Interview Access Only", exact=True).is_visible()
        red, green, blue = cards.first.evaluate(
            "element => getComputedStyle(element).backgroundColor.match(/\\d+/g).slice(0, 3).map(Number)"
        )
        assert max(red, green, blue) <= 30
        cards.first.click(force=True)
        assert page.locator("#detail-modal").is_hidden()

    assert protected_requests == []
    assert page.locator('[src*="/protected/"], [poster*="/protected/"]').count() == 0
    assert page.evaluate(
        """() => [...document.querySelectorAll('*')].every(element =>
            [...element.attributes].every(attribute => !attribute.value.includes('/protected/'))
        )"""
    )


def test_interview_form_enter_unlocks_both_projects_once(
    page: Page, portfolio_url: str
) -> None:
    configured_password = secrets.token_urlsafe(32)
    calls = install_interview_api(page, configured_password)
    page.goto(portfolio_url, wait_until="domcontentloaded")

    page.get_by_role("button", name="면접용 전체 포트폴리오", exact=True).click()
    page.get_by_label("비밀번호").fill(configured_password)
    page.get_by_label("비밀번호").press("Enter")
    page.locator("#gallery-shell").wait_for(state="visible")
    assert calls["login"] == 1

    for title, count in (("Project MP", 6), ("Project DM", 18)):
        page.get_by_role("button", name=title, exact=True).click()
        cards = page.locator("#gallery-grid > button")
        assert cards.count() == count
        assert page.locator('#gallery-grid [data-locked="true"]').count() == 0
        cards.first.click()
        assert page.locator("#detail-modal").is_visible()
        viewer_image = page.locator("#modal-media-container img")
        viewer_image.wait_for(state="visible")
        assert viewer_image.get_attribute("src") in calls["protected_urls"][
            "project-mp" if title == "Project MP" else "project-dm"
        ]
        page.get_by_role("button", name="상세 이미지 닫기").click()

    assert calls["login"] == 1


def test_authenticated_refresh_restores_access_without_another_login(
    page: Page, portfolio_url: str
) -> None:
    configured_password = secrets.token_urlsafe(32)
    calls = install_interview_api(page, configured_password)
    page.goto(portfolio_url, wait_until="domcontentloaded")
    page.get_by_role("button", name="면접용 전체 포트폴리오", exact=True).click()
    page.get_by_label("비밀번호").fill(configured_password)
    page.get_by_label("비밀번호").press("Enter")
    page.locator("#gallery-shell").wait_for(state="visible")

    page.reload(wait_until="domcontentloaded")

    page.locator("#gallery-shell").wait_for(state="visible")
    assert page.locator("#entrance-screen").is_hidden()
    for title in ("Project MP", "Project DM"):
        page.get_by_role("button", name=title, exact=True).click()
        assert page.locator('#gallery-grid [data-locked="true"]').count() == 0
    assert calls["login"] == 1


def test_manual_relock_discards_protected_dom_and_returns_to_guest(
    page: Page, portfolio_url: str
) -> None:
    configured_password = secrets.token_urlsafe(32)
    calls = install_interview_api(page, configured_password)
    page.goto(portfolio_url, wait_until="domcontentloaded")
    page.get_by_role("button", name="면접용 전체 포트폴리오", exact=True).click()
    page.get_by_label("비밀번호").fill(configured_password)
    page.get_by_label("비밀번호").press("Enter")
    page.locator("#gallery-shell").wait_for(state="visible")
    page.get_by_role("button", name="Project MP", exact=True).click()
    assert page.locator('[src*="/protected/"]').count() == 6
    page.locator('#gallery-grid img').evaluate_all(
        "images => images.forEach(image => image.loading = 'eager')"
    )
    page.wait_for_function(
        "() => [...document.querySelectorAll('#gallery-grid img')].every(image => image.complete)"
    )

    protected_calls = calls["protected"]
    assert isinstance(protected_calls, list)
    protected_calls.clear()
    page.get_by_role("button", name="다시 잠그기", exact=True).click()
    page.get_by_role("button", name="Project MP", exact=True).click()

    assert calls["logout"] == 1
    assert page.locator('#gallery-grid [data-locked="true"]').count() == 6
    assert page.locator('[src*="/protected/"], [poster*="/protected/"]').count() == 0
    assert protected_calls == []


def test_successful_relock_discards_protected_dom_before_public_manifest_returns(
    page: Page, portfolio_url: str
) -> None:
    configured_password = secrets.token_urlsafe(32)
    calls = install_interview_api(
        page,
        configured_password,
        defer_public_projects=True,
    )
    page.goto(portfolio_url, wait_until="domcontentloaded")
    page.get_by_role("button", name="면접용 전체 포트폴리오", exact=True).click()
    page.get_by_label("비밀번호").fill(configured_password)
    page.get_by_label("비밀번호").press("Enter")
    page.locator("#gallery-shell").wait_for(state="visible")
    page.get_by_role("button", name="Project MP", exact=True).click()
    assert page.locator('[src*="/protected/"]').count() == 6

    page.get_by_role("button", name="다시 잠그기", exact=True).click()
    page.wait_for_function(
        "() => document.querySelector('#gallery-shell').hidden",
    )
    pending_public_projects = calls["pending_public_projects"]
    assert isinstance(pending_public_projects, list)
    for _ in range(50):
        if len(pending_public_projects) == 1:
            break
        page.wait_for_timeout(10)
    assert len(pending_public_projects) == 1

    assert calls["logout"] == 1
    assert page.locator('[src*="/protected/"], [poster*="/protected/"]').count() == 0
    assert page.locator("#category-tabs").text_content() == ""
    assert page.locator("#gallery-grid").text_content() == ""
    assert page.locator("#entrance-screen").is_visible()

    delayed_manifest = pending_public_projects.pop()
    assert isinstance(delayed_manifest, Route)
    delayed_manifest.fulfill(status=200, json=guest_manifest())
    page.locator("#gallery-shell").wait_for(state="visible")
    assert page.locator("#access-status").text_content() == "공개 보기"


def test_failed_relock_purges_dom_and_warns_that_server_access_remains_active(
    page: Page, portfolio_url: str
) -> None:
    configured_password = secrets.token_urlsafe(32)
    calls = install_interview_api(page, configured_password, logout_status=503)
    page.goto(portfolio_url, wait_until="domcontentloaded")
    page.get_by_role("button", name="면접용 전체 포트폴리오", exact=True).click()
    page.get_by_label("비밀번호").fill(configured_password)
    page.get_by_label("비밀번호").press("Enter")
    page.locator("#gallery-shell").wait_for(state="visible")
    page.get_by_role("button", name="Project MP", exact=True).click()

    page.get_by_role("button", name="다시 잠그기", exact=True).click()
    page.get_by_text("서버 접근이 아직 활성화", exact=False).wait_for()

    assert calls["logout"] == 1
    assert page.locator("#gallery-shell").is_hidden()
    assert page.locator('[src*="/protected/"], [poster*="/protected/"]').count() == 0
    assert page.locator("#gallery-grid").text_content() == ""
    assert page.locator("#category-tabs").text_content() == ""
    assert page.locator("#entrance-screen").is_visible()
    assert page.get_by_text("서버 접근이 아직 활성화", exact=False).is_visible()
    assert page.get_by_role("button", name="공개 포트폴리오", exact=True).is_enabled()


def test_gallery_entry_moves_focus_to_a_real_heading(page: Page, portfolio_url: str) -> None:
    install_guest_api(page)
    page.goto(portfolio_url, wait_until="domcontentloaded")
    page.get_by_role("button", name="공개 포트폴리오", exact=True).press("Enter")
    page.locator("#gallery-shell").wait_for(state="visible")
    heading = page.get_by_role("heading", name="Jin Kim Portfolio", exact=True)
    assert heading.is_visible()
    page.wait_for_function("document.querySelector('#gallery-title') === document.activeElement")
    assert heading.evaluate("element => element === document.activeElement")


def test_wrong_password_stays_locked_with_generic_error(
    page: Page, portfolio_url: str
) -> None:
    configured_password = secrets.token_urlsafe(32)
    calls = install_interview_api(page, configured_password)
    page.goto(portfolio_url, wait_until="domcontentloaded")
    page.get_by_role("button", name="면접용 전체 포트폴리오", exact=True).click()
    page.get_by_label("비밀번호").fill(secrets.token_urlsafe(32))
    page.get_by_label("비밀번호").press("Enter")

    page.locator("#login-error").get_by_text("인증에 실패했습니다", exact=False).wait_for()
    assert page.locator("#gallery-shell").is_hidden()
    assert calls["login"] == 1
    assert calls["protected"] == []


def test_explicit_public_choice_wins_a_delayed_authenticated_restore(
    page: Page, portfolio_url: str
) -> None:
    calls = install_interview_api(page, secrets.token_urlsafe(32))
    origin = portfolio_url.rsplit(PORTFOLIO_PATH, 1)[0]
    session_value = calls["session_value"]
    assert isinstance(session_value, str)
    page.context.add_cookies(
        [{"name": "browser_session", "value": session_value, "url": origin}]
    )
    page.add_init_script(
        """
        (() => {
            const originalFetch = window.fetch.bind(window);
            let releaseSession;
            const sessionGate = new Promise(resolve => { releaseSession = resolve; });
            window.__releaseDelayedSession = releaseSession;
            window.fetch = async (input, options) => {
                const url = new URL(typeof input === 'string' ? input : input.url, location.href);
                const response = await originalFetch(input, options);
                if (url.pathname === '/api/auth/session') await sessionGate;
                return response;
            };
        })();
        """
    )

    page.goto(portfolio_url, wait_until="domcontentloaded")
    page.wait_for_function("typeof window.__releaseDelayedSession === 'function'")
    page.get_by_role("button", name="공개 포트폴리오", exact=True).press("Enter")
    page.locator("#gallery-shell").wait_for(state="visible")
    assert page.locator("#access-status").text_content() == "공개 보기"
    assert calls["logout"] == 1
    assert all(
        cookie.get("name") != "browser_session"
        for cookie in page.context.cookies(origin)
    )

    page.evaluate("window.__releaseDelayedSession()")
    page.wait_for_timeout(300)

    assert calls["projects_authenticated"] == 0
    assert page.locator("#access-status").text_content() == "공개 보기"
    page.get_by_role("button", name="Project MP", exact=True).click()
    assert page.locator('#gallery-grid [data-locked="true"]').count() == 6
    assert calls["protected"] == []


def test_delayed_public_logout_finishes_before_new_interview_login(
    page: Page, portfolio_url: str
) -> None:
    configured_password = secrets.token_urlsafe(32)
    calls = install_interview_api(page, configured_password, defer_logout=True)
    install_session_mutation_probe(page)
    origin = portfolio_url.rsplit(PORTFOLIO_PATH, 1)[0]

    page.goto(portfolio_url, wait_until="domcontentloaded")
    public_choice = page.get_by_role(
        "button", name="공개 포트폴리오", exact=True
    )
    public_choice.press("Enter")
    expect(public_choice).to_be_disabled()

    for _ in range(50):
        if calls["logout"] == 1:
            break
        page.wait_for_timeout(10)
    assert calls["logout"] == 1
    pending_logout = calls["pending_logout"]
    assert isinstance(pending_logout, list)
    assert len(pending_logout) == 1

    page.get_by_role(
        "button", name="면접용 전체 포트폴리오", exact=True
    ).click()
    page.get_by_label("비밀번호").fill(configured_password)
    page.get_by_label("비밀번호").press("Enter")
    wait_for_pending_session_lock(page, "/api/auth/login")
    login_calls = calls["login"]
    assert isinstance(login_calls, int)
    login_calls_before_logout_finished = login_calls

    delayed_logout = pending_logout.pop()
    assert isinstance(delayed_logout, Route)
    delayed_logout.fulfill(
        status=204,
        headers={
            "Set-Cookie": "browser_session=; Max-Age=0; Path=/; SameSite=Strict"
        },
    )

    page.locator("#gallery-shell").wait_for(state="visible")
    page.wait_for_timeout(100)
    cookies = page.context.cookies(origin)
    session = page.evaluate(
        "() => fetch('/api/auth/session').then(response => response.json())"
    )
    protected_urls = calls["protected_urls"]
    assert isinstance(protected_urls, dict)
    protected_status = page.evaluate(
        "url => fetch(url).then(response => response.status)",
        protected_urls["project-mp"][0],
    )

    assert login_calls_before_logout_finished == 0
    session_value = calls["session_value"]
    assert isinstance(session_value, str)
    assert any(
        cookie.get("name") == "browser_session" and cookie.get("value") == session_value
        for cookie in cookies
    )
    assert session == {"authenticated": True}
    assert protected_status == 200
    assert page.locator("#access-status").text_content() == "면접용 전체 보기"


def test_delayed_public_logout_in_one_tab_finishes_before_login_in_another(
    page: Page, portfolio_url: str
) -> None:
    configured_password = secrets.token_urlsafe(32)
    calls = install_interview_api(page, configured_password, defer_logout=True)
    install_session_mutation_probe(page)
    origin = portfolio_url.rsplit(PORTFOLIO_PATH, 1)[0]

    page.goto(portfolio_url, wait_until="domcontentloaded")
    page.get_by_role("button", name="공개 포트폴리오", exact=True).press("Enter")
    for _ in range(50):
        if calls["logout"] == 1:
            break
        page.wait_for_timeout(10)
    assert calls["logout"] == 1
    pending_logout = calls["pending_logout"]
    assert isinstance(pending_logout, list)
    assert len(pending_logout) == 1

    interview_page = page.context.new_page()
    install_session_mutation_probe(interview_page)
    interview_page.goto(portfolio_url, wait_until="domcontentloaded")
    interview_page.get_by_role(
        "button", name="면접용 전체 포트폴리오", exact=True
    ).click()
    interview_page.get_by_label("비밀번호").fill(configured_password)
    interview_page.get_by_label("비밀번호").press("Enter")
    wait_for_pending_session_lock(interview_page, "/api/auth/login")
    login_calls = calls["login"]
    assert isinstance(login_calls, int)
    login_calls_before_logout_finished = login_calls

    delayed_logout = pending_logout.pop()
    assert isinstance(delayed_logout, Route)
    delayed_logout.fulfill(
        status=204,
        headers={
            "Set-Cookie": "browser_session=; Max-Age=0; Path=/; SameSite=Strict"
        },
    )

    interview_page.locator("#gallery-shell").wait_for(state="visible")
    interview_page.wait_for_timeout(100)
    cookies = page.context.cookies(origin)
    session = interview_page.evaluate(
        "() => fetch('/api/auth/session').then(response => response.json())"
    )
    protected_urls = calls["protected_urls"]
    assert isinstance(protected_urls, dict)
    protected_status = interview_page.evaluate(
        "url => fetch(url).then(response => response.status)",
        protected_urls["project-mp"][0],
    )

    assert login_calls_before_logout_finished == 0
    session_value = calls["session_value"]
    assert isinstance(session_value, str)
    assert any(
        cookie.get("name") == "browser_session" and cookie.get("value") == session_value
        for cookie in cookies
    )
    assert session == {"authenticated": True}
    assert protected_status == 200
    assert interview_page.locator("#access-status").text_content() == "면접용 전체 보기"


def test_delayed_login_in_one_tab_finishes_before_newer_logout_in_another(
    page: Page, portfolio_url: str
) -> None:
    configured_password = secrets.token_urlsafe(32)
    calls = install_interview_api(page, configured_password, defer_login=True)
    install_session_mutation_probe(page)
    origin = portfolio_url.rsplit(PORTFOLIO_PATH, 1)[0]

    page.goto(portfolio_url, wait_until="domcontentloaded")
    page.get_by_role("button", name="면접용 전체 포트폴리오", exact=True).click()
    page.get_by_label("비밀번호").fill(configured_password)
    page.get_by_label("비밀번호").press("Enter")
    for _ in range(50):
        if calls["login"] == 1:
            break
        page.wait_for_timeout(10)
    assert calls["login"] == 1
    pending_login = calls["pending_login"]
    assert isinstance(pending_login, list)
    assert len(pending_login) == 1

    public_page = page.context.new_page()
    install_session_mutation_probe(public_page)
    public_page.goto(portfolio_url, wait_until="domcontentloaded")
    public_page.get_by_role("button", name="공개 포트폴리오", exact=True).press("Enter")
    wait_for_pending_session_lock(public_page, "/api/auth/logout")
    assert calls["logout"] == 0

    session_value = calls["session_value"]
    assert isinstance(session_value, str)
    delayed_login = pending_login.pop()
    assert isinstance(delayed_login, Route)
    delayed_login.fulfill(
        status=204,
        headers={
            "Set-Cookie": f"browser_session={session_value}; Path=/; SameSite=Strict"
        },
    )

    public_page.locator("#gallery-shell").wait_for(state="visible")
    session = public_page.evaluate(
        "() => fetch('/api/auth/session').then(response => response.json())"
    )
    protected_urls = calls["protected_urls"]
    assert isinstance(protected_urls, dict)
    protected_status = public_page.evaluate(
        "url => fetch(url).then(response => response.status)",
        protected_urls["project-mp"][0],
    )

    assert calls["logout"] == 1
    assert all(
        cookie.get("name") != "browser_session"
        for cookie in page.context.cookies(origin)
    )
    assert session == {"authenticated": False}
    assert protected_status == 401
    assert public_page.locator("#access-status").text_content() == "공개 보기"
    assert page.locator("#gallery-shell").is_hidden()
    assert page.locator('[src*="/protected/"], [poster*="/protected/"]').count() == 0


def test_newer_logout_supersedes_login_queued_behind_an_older_logout(
    page: Page, portfolio_url: str
) -> None:
    configured_password = secrets.token_urlsafe(32)
    calls = install_interview_api(page, configured_password, defer_logout=True)
    install_session_mutation_probe(page)
    page.expose_function(
        "__pendingLogoutCountForTest",
        lambda: len(calls["pending_logout"]),
    )
    origin = portfolio_url.rsplit(PORTFOLIO_PATH, 1)[0]

    login_page = page.context.new_page()
    newer_logout_page = page.context.new_page()
    for candidate in (login_page, newer_logout_page):
        install_session_mutation_probe(candidate)

    for candidate in (page, login_page, newer_logout_page):
        candidate.goto(portfolio_url, wait_until="domcontentloaded")

    page.get_by_role("button", name="공개 포트폴리오", exact=True).press("Enter")
    wait_for_held_session_lock(page, "/api/auth/logout")

    login_page.get_by_role(
        "button", name="면접용 전체 포트폴리오", exact=True
    ).click()
    login_page.get_by_label("비밀번호").fill(configured_password)
    login_page.get_by_label("비밀번호").press("Enter")
    wait_for_pending_session_lock(login_page, "/api/auth/login")
    page.wait_for_function(
        "async () => await window.__pendingLogoutCountForTest() === 1"
    )
    pending_logout = calls["pending_logout"]
    assert isinstance(pending_logout, list)

    newer_logout_page.get_by_role(
        "button", name="공개 포트폴리오", exact=True
    ).press("Enter")
    wait_for_pending_session_lock(newer_logout_page, "/api/auth/logout")

    older_logout = pending_logout.pop(0)
    assert isinstance(older_logout, Route)
    with newer_logout_page.expect_request("**/api/auth/logout"):
        older_logout.fulfill(
            status=204,
            headers={
                "Set-Cookie": "browser_session=; Max-Age=0; Path=/; SameSite=Strict"
            },
        )

    wait_for_held_session_lock(newer_logout_page, "/api/auth/logout")
    page.wait_for_function(
        "async () => await window.__pendingLogoutCountForTest() === 1"
    )
    assert calls["login"] == 0
    assert calls["logout"] == 2
    for candidate in (page, login_page, newer_logout_page):
        assert candidate.locator("#gallery-shell").is_hidden()
        assert candidate.locator(
            '[src*="/protected/"], [poster*="/protected/"]'
        ).count() == 0

    newest_logout = pending_logout.pop(0)
    assert isinstance(newest_logout, Route)
    newest_logout.fulfill(
        status=204,
        headers={
            "Set-Cookie": "browser_session=; Max-Age=0; Path=/; SameSite=Strict"
        },
    )
    newer_logout_page.locator("#gallery-shell").wait_for(state="visible")
    newer_logout_page.wait_for_function(
        """async lockName => {
            const snapshot = await navigator.locks.query();
            return !snapshot.held.some(lock => lock.name === lockName)
                && !snapshot.pending.some(lock => lock.name === lockName);
        }""",
        arg=SESSION_MUTATION_LOCK,
    )

    session = newer_logout_page.evaluate(
        "() => fetch('/api/auth/session').then(response => response.json())"
    )
    protected_urls = calls["protected_urls"]
    assert isinstance(protected_urls, dict)
    protected_status = newer_logout_page.evaluate(
        "url => fetch(url).then(response => response.status)",
        protected_urls["project-mp"][0],
    )
    assert session == {"authenticated": False}
    assert protected_status == 401
    assert all(
        cookie.get("name") != "browser_session"
        for cookie in page.context.cookies(origin)
    )
    for candidate in (page, login_page, newer_logout_page):
        assert candidate.locator(
            '[src*="/protected/"], [poster*="/protected/"]'
        ).count() == 0
        if candidate.locator("#gallery-shell").is_visible():
            assert candidate.locator("#access-status").text_content() == "공개 보기"


def test_logout_registers_web_lock_before_publishing_cross_tab_intent(
    page: Page, portfolio_url: str
) -> None:
    configured_password = secrets.token_urlsafe(32)
    install_interview_api(page, configured_password)
    page.add_init_script(
        f"""(() => {{
            window.__sessionCoordinationOrder = [];
            const originalRequest = LockManager.prototype.request;
            LockManager.prototype.request = function (...args) {{
                if (args[0] === {json.dumps(SESSION_MUTATION_LOCK)}) {{
                    window.__sessionCoordinationOrder.push('lock-request');
                }}
                return originalRequest.apply(this, args);
            }};
            const originalSetItem = Storage.prototype.setItem;
            Storage.prototype.setItem = function (key, value) {{
                if (key === {json.dumps(SESSION_INTENT_STORAGE_KEY)}) {{
                    window.__sessionCoordinationOrder.push('intent-storage');
                }}
                return originalSetItem.call(this, key, value);
            }};
        }})();"""
    )

    page.goto(portfolio_url, wait_until="domcontentloaded")
    page.get_by_role("button", name="공개 포트폴리오", exact=True).press("Enter")
    page.wait_for_function(
        "() => window.__sessionCoordinationOrder.includes('intent-storage')"
    )

    assert page.evaluate("window.__sessionCoordinationOrder.slice(0, 2)") == [
        "lock-request",
        "intent-storage",
    ]


@pytest.mark.parametrize("delivery", ["broadcast", "storage"])
def test_successful_login_ignores_superseded_logout_notification(
    page: Page, portfolio_url: str, delivery: str
) -> None:
    configured_password = secrets.token_urlsafe(32)
    calls = install_interview_api(page, configured_password)

    page.goto(portfolio_url, wait_until="domcontentloaded")
    page.get_by_role("button", name="공개 포트폴리오", exact=True).press("Enter")
    page.locator("#gallery-shell").wait_for(state="visible")
    stale_intent = page.evaluate(
        "key => localStorage.getItem(key)", SESSION_INTENT_STORAGE_KEY
    )
    assert isinstance(stale_intent, str)

    page.goto(f"{portfolio_url}?mode=interview", wait_until="domcontentloaded")
    page.get_by_label("비밀번호").fill(configured_password)
    page.get_by_label("비밀번호").press("Enter")
    page.locator("#gallery-shell").wait_for(state="visible")
    assert page.locator("#access-status").text_content() == "면접용 전체 보기"
    login_barrier = page.evaluate(
        "key => JSON.parse(localStorage.getItem(key))", SESSION_INTENT_STORAGE_KEY
    )
    assert login_barrier["kind"] == "login"
    assert login_barrier["id"]

    if delivery == "broadcast":
        page.evaluate(
            """({ channelName, rawIntent }) => {
                const channel = new BroadcastChannel(channelName);
                channel.postMessage({ intent: JSON.parse(rawIntent), persisted: true });
                setTimeout(() => channel.close(), 100);
            }""",
            {"channelName": SESSION_INTENT_CHANNEL_NAME, "rawIntent": stale_intent},
        )
    else:
        page.evaluate(
            """({ key, rawIntent }) => {
                dispatchEvent(new StorageEvent('storage', { key, newValue: rawIntent }));
            }""",
            {"key": SESSION_INTENT_STORAGE_KEY, "rawIntent": stale_intent},
        )
    page.wait_for_timeout(100)

    assert page.locator("#gallery-shell").is_visible()
    assert page.locator("#access-status").text_content() == "면접용 전체 보기"
    session = page.evaluate(
        "() => fetch('/api/auth/session').then(response => response.json())"
    )
    assert session == {"authenticated": True}
    assert calls["login"] == 1


def test_logout_intent_purges_protected_dom_from_every_open_tab_before_response(
    page: Page, portfolio_url: str
) -> None:
    configured_password = secrets.token_urlsafe(32)
    calls = install_interview_api(page, configured_password, defer_logout=True)
    instrumented_script = (
        (STATIC_ROOT / "portfolio.js").read_text(encoding="utf-8")
        + "\nwindow.__getLastFocusedElementForTest = () => state.lastFocusedElement;\n"
    )
    page.route(
        "**/portfolio.js",
        lambda route: route.fulfill(
            status=200,
            content_type="text/javascript; charset=utf-8",
            body=instrumented_script,
        ),
    )

    page.goto(portfolio_url, wait_until="domcontentloaded")
    page.get_by_role("button", name="면접용 전체 포트폴리오", exact=True).click()
    page.get_by_label("비밀번호").fill(configured_password)
    page.get_by_label("비밀번호").press("Enter")
    page.locator("#gallery-shell").wait_for(state="visible")
    page.get_by_role("button", name="Project MP", exact=True).click()
    assert page.locator('[src*="/protected/"]').count() == 6
    page.locator("#gallery-grid .artwork-card").first.click()
    page.locator("#detail-modal").wait_for(state="visible")
    assert page.locator("#modal-title").text_content()

    relock_page = page.context.new_page()
    relock_page.goto(portfolio_url, wait_until="domcontentloaded")
    relock_page.locator("#gallery-shell").wait_for(state="visible")
    relock_page.get_by_role("button", name="Project MP", exact=True).click()
    assert relock_page.locator('[src*="/protected/"]').count() == 6

    relock_page.get_by_role("button", name="다시 잠그기", exact=True).click()
    for _ in range(50):
        if calls["logout"] == 1:
            break
        relock_page.wait_for_timeout(10)
    assert calls["logout"] == 1
    pending_logout = calls["pending_logout"]
    assert isinstance(pending_logout, list)
    assert len(pending_logout) == 1

    page.wait_for_function("() => document.querySelector('#gallery-shell').hidden")
    assert relock_page.locator("#gallery-shell").is_hidden()
    retained_viewer_source = page.evaluate(
        """() => ({
            retained: window.__getLastFocusedElementForTest() !== null,
            protectedMedia: window.__getLastFocusedElementForTest()?.querySelectorAll(
                '[src*="/protected/"], [poster*="/protected/"]'
            ).length ?? 0,
        })"""
    )
    assert retained_viewer_source == {"retained": False, "protectedMedia": 0}
    for candidate in (page, relock_page):
        assert candidate.locator("#detail-modal").is_hidden()
        assert candidate.locator(
            '[src*="/protected/"], [poster*="/protected/"]'
        ).count() == 0
        assert candidate.locator("#gallery-grid").text_content() == ""
        assert candidate.locator("#category-tabs").text_content() == ""
        assert candidate.locator("#modal-title").text_content() == ""
        assert candidate.locator("#modal-description").text_content() == ""
        assert candidate.locator("#entrance-screen").is_visible()

    delayed_logout = pending_logout.pop()
    assert isinstance(delayed_logout, Route)
    delayed_logout.fulfill(
        status=204,
        headers={
            "Set-Cookie": "browser_session=; Max-Age=0; Path=/; SameSite=Strict"
        },
    )
    relock_page.locator("#gallery-shell").wait_for(state="visible")


def test_hung_session_mutation_times_out_and_releases_cross_tab_lock(
    page: Page, portfolio_url: str
) -> None:
    configured_password = secrets.token_urlsafe(32)
    calls = install_interview_api(page, configured_password, defer_logout=True)
    page.clock.install()
    install_session_mutation_probe(page)

    page.goto(portfolio_url, wait_until="domcontentloaded")
    interview_page = page.context.new_page()
    install_session_mutation_probe(interview_page)
    interview_page.goto(portfolio_url, wait_until="domcontentloaded")

    page.get_by_role("button", name="공개 포트폴리오", exact=True).press("Enter")
    for _ in range(50):
        if calls["logout"] == 1:
            break
        page.wait_for_timeout(10)
    assert calls["logout"] == 1

    interview_page.get_by_role(
        "button", name="면접용 전체 포트폴리오", exact=True
    ).click()
    interview_page.get_by_label("비밀번호").fill(configured_password)
    interview_page.get_by_label("비밀번호").press("Enter")
    wait_for_pending_session_lock(interview_page, "/api/auth/login")
    assert calls["login"] == 0

    page.clock.fast_forward(SESSION_MUTATION_TIMEOUT_MS)
    interview_page.locator("#gallery-shell").wait_for(state="visible")

    assert calls["login"] == 1
    assert interview_page.locator("#access-status").text_content() == "면접용 전체 보기"
    session = interview_page.evaluate(
        "() => fetch('/api/auth/session').then(response => response.json())"
    )
    assert session == {"authenticated": True}

    pending_logout = calls["pending_logout"]
    assert isinstance(pending_logout, list)
    assert len(pending_logout) == 1
    stale_logout = pending_logout.pop()
    assert isinstance(stale_logout, Route)
    stale_logout.fulfill(
        status=204,
        headers={
            "Set-Cookie": "browser_session=; Max-Age=0; Path=/; SameSite=Strict"
        },
    )
    interview_page.wait_for_timeout(100)

    session_after_stale_response = interview_page.evaluate(
        "() => fetch('/api/auth/session').then(response => response.json())"
    )
    protected_urls = calls["protected_urls"]
    assert isinstance(protected_urls, dict)
    protected_status = interview_page.evaluate(
        "url => fetch(url).then(response => response.status)",
        protected_urls["project-mp"][0],
    )
    assert session_after_stale_response == {"authenticated": True}
    assert protected_status == 200


def test_rejected_session_mutation_releases_lock_for_next_login(
    page: Page, portfolio_url: str
) -> None:
    configured_password = secrets.token_urlsafe(32)
    calls = install_interview_api(page, configured_password, abort_logout=True)

    page.goto(portfolio_url, wait_until="domcontentloaded")
    page.get_by_role("button", name="공개 포트폴리오", exact=True).press("Enter")
    page.get_by_text("포트폴리오를 불러오지 못했습니다", exact=False).wait_for()
    assert calls["logout"] == 1

    page.get_by_role("button", name="면접용 전체 포트폴리오", exact=True).click()
    page.get_by_label("비밀번호").fill(configured_password)
    page.get_by_label("비밀번호").press("Enter")
    page.locator("#gallery-shell").wait_for(state="visible")

    assert calls["login"] == 1
    assert page.locator("#access-status").text_content() == "면접용 전체 보기"

    page.reload(wait_until="domcontentloaded")
    page.locator("#gallery-shell").wait_for(state="visible")
    assert page.locator("#access-status").text_content() == "면접용 전체 보기"


def test_closing_lock_holder_releases_waiting_cross_tab_login(
    page: Page, portfolio_url: str
) -> None:
    configured_password = secrets.token_urlsafe(32)
    calls = install_interview_api(page, configured_password, defer_logout=True)

    page.goto(portfolio_url, wait_until="domcontentloaded")
    page.get_by_role("button", name="공개 포트폴리오", exact=True).press("Enter")
    for _ in range(50):
        if calls["logout"] == 1:
            break
        page.wait_for_timeout(10)
    assert calls["logout"] == 1

    interview_page = page.context.new_page()
    install_session_mutation_probe(interview_page)
    interview_page.goto(portfolio_url, wait_until="domcontentloaded")
    interview_page.get_by_role(
        "button", name="면접용 전체 포트폴리오", exact=True
    ).click()
    interview_page.get_by_label("비밀번호").fill(configured_password)
    interview_page.get_by_label("비밀번호").press("Enter")
    wait_for_pending_session_lock(interview_page, "/api/auth/login")
    assert calls["login"] == 0

    page.close()
    interview_page.locator("#gallery-shell").wait_for(state="visible")

    assert calls["login"] == 1
    assert interview_page.locator("#access-status").text_content() == "면접용 전체 보기"


def test_waiting_session_mutation_times_out_without_issuing_fetch(
    page: Page, portfolio_url: str
) -> None:
    configured_password = secrets.token_urlsafe(32)
    calls = install_interview_api(page, configured_password, defer_logout=True)

    page.goto(portfolio_url, wait_until="domcontentloaded")
    page.get_by_role("button", name="공개 포트폴리오", exact=True).press("Enter")
    for _ in range(50):
        if calls["logout"] == 1:
            break
        page.wait_for_timeout(10)
    assert calls["logout"] == 1

    interview_page = page.context.new_page()
    interview_page.clock.install()
    install_session_mutation_probe(interview_page)
    interview_page.goto(portfolio_url, wait_until="domcontentloaded")
    interview_page.get_by_role(
        "button", name="면접용 전체 포트폴리오", exact=True
    ).click()
    interview_page.get_by_label("비밀번호").fill(configured_password)
    interview_page.get_by_label("비밀번호").press("Enter")
    wait_for_pending_session_lock(interview_page, "/api/auth/login")

    interview_page.clock.fast_forward(SESSION_LOCK_WAIT_TIMEOUT_MS)
    interview_page.get_by_text("인증에 실패했습니다", exact=False).wait_for()

    assert calls["login"] == 0
    assert interview_page.locator("#gallery-shell").is_hidden()
    lock_snapshot = interview_page.evaluate(
        """async lockName => {
            const snapshot = await navigator.locks.query();
            return snapshot.pending.filter(lock => lock.name === lockName).length;
        }""",
        SESSION_MUTATION_LOCK,
    )
    assert lock_snapshot == 0


def test_missing_web_locks_fails_closed_without_session_mutation(
    page: Page, portfolio_url: str
) -> None:
    configured_password = secrets.token_urlsafe(32)
    calls = install_interview_api(page, configured_password)
    page.add_init_script(
        "Object.defineProperty(Navigator.prototype, 'locks', { configurable: true, value: undefined });"
    )

    page.goto(portfolio_url, wait_until="domcontentloaded")
    page.get_by_role("button", name="면접용 전체 포트폴리오", exact=True).click()
    page.get_by_label("비밀번호").fill(configured_password)
    page.get_by_label("비밀번호").press("Enter")
    page.get_by_text("인증에 실패했습니다", exact=False).wait_for()

    assert calls["login"] == 0
    assert page.locator("#gallery-shell").is_hidden()

    page.get_by_role("button", name="선택으로 돌아가기", exact=True).click()
    page.get_by_role("button", name="공개 포트폴리오", exact=True).press("Enter")
    page.get_by_text("포트폴리오를 불러오지 못했습니다", exact=False).wait_for()
    assert calls["logout"] == 0
    assert page.locator("#gallery-shell").is_hidden()


@pytest.mark.parametrize("viewport", [(390, 844), (320, 568)])
def test_authenticated_gallery_has_no_mobile_horizontal_overflow(
    page: Page, portfolio_url: str, viewport: tuple[int, int]
) -> None:
    width, height = viewport
    page.set_viewport_size({"width": width, "height": height})
    configured_password = secrets.token_urlsafe(32)
    install_interview_api(page, configured_password)
    page.goto(portfolio_url, wait_until="domcontentloaded")
    page.get_by_role("button", name="면접용 전체 포트폴리오", exact=True).click()
    page.get_by_label("비밀번호").fill(configured_password)
    page.get_by_label("비밀번호").press("Enter")
    page.locator("#gallery-shell").wait_for(state="visible")
    page.get_by_role("button", name="Project DM", exact=True).click()

    assert page.evaluate(
        "document.documentElement.scrollWidth <= document.documentElement.clientWidth"
    )
