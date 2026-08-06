# pyright: reportMissingImports=false
from __future__ import annotations

import functools
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
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        yield page
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
    page: Page, configured_password: str, *, logout_status: int = 204
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

    page.route("**/api/**", route_api)
    page.route("**/protected/**", route_protected)
    return calls


def test_static_github_pages_uses_relative_assets_and_guest_manifest_only(page: Page) -> None:
    requests = install_static_github_pages(page)
    page.goto(
        "https://kimyeonkyu.github.io/Resume/jin_kim_portfolio.html",
        wait_until="domcontentloaded",
    )

    page.get_by_role("button", name="공개 포트폴리오", exact=True).click()
    page.locator("#gallery-shell").wait_for(state="visible")

    for title, locked_count in (("워헤이븐", 10), ("Project MP", 5), ("Project DM", 18)):
        page.get_by_role("button", name=title, exact=True).click()
        assert page.locator('#gallery-grid [data-locked="true"]').count() == locked_count

    assert any("/Resume/portfolio.css" in url for url in requests)
    assert any("/Resume/portfolio.js" in url for url in requests)
    assert any("/Resume/public-portfolio-manifest.json" in url for url in requests)
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


def test_entrance_offers_both_modes_and_interview_form(
    page: Page, portfolio_url: str
) -> None:
    install_guest_api(page)

    page.goto(portfolio_url, wait_until="domcontentloaded")

    assert page.get_by_role("button", name="면접용 전체 포트폴리오", exact=True).is_visible()
    assert page.get_by_role("button", name="공개 포트폴리오", exact=True).is_visible()
    assert page.locator("#gallery-shell").is_hidden()

    page.get_by_role("button", name="면접용 전체 포트폴리오", exact=True).click()
    form = page.get_by_role("form", name="면접용 포트폴리오 로그인")
    assert form.is_visible()
    assert form.get_by_label("비밀번호").get_attribute("type") == "password"


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

    page.get_by_role("button", name="공개 포트폴리오", exact=True).click()
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


def test_failed_relock_keeps_access_visibly_active_and_offers_retry(
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
    page.get_by_text("접근이 아직 활성화", exact=False).wait_for()

    assert calls["logout"] == 1
    assert page.locator("#gallery-shell").is_visible()
    assert page.locator("#access-status").text_content() == "면접용 전체 보기"
    assert page.locator('[src*="/protected/"]').count() == 6
    assert page.get_by_text("접근이 아직 활성화", exact=False).is_visible()
    assert page.get_by_role("button", name="다시 잠그기", exact=True).is_enabled()


def test_gallery_entry_moves_focus_to_a_real_heading(page: Page, portfolio_url: str) -> None:
    install_guest_api(page)
    page.goto(portfolio_url, wait_until="domcontentloaded")
    page.get_by_role("button", name="공개 포트폴리오", exact=True).click()
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
    page.get_by_role("button", name="공개 포트폴리오", exact=True).click()
    page.locator("#gallery-shell").wait_for(state="visible")
    assert page.locator("#access-status").text_content() == "공개 보기"
    assert calls["logout"] == 1
    assert all(
        cookie["name"] != "browser_session"
        for cookie in page.context.cookies(origin)
    )

    page.evaluate("window.__releaseDelayedSession()")
    page.wait_for_timeout(300)

    assert calls["projects_authenticated"] == 0
    assert page.locator("#access-status").text_content() == "공개 보기"
    page.get_by_role("button", name="Project MP", exact=True).click()
    assert page.locator('#gallery-grid [data-locked="true"]').count() == 6
    assert calls["protected"] == []


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
