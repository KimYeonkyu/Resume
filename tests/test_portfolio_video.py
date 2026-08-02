# pyright: reportMissingImports=false
from __future__ import annotations

import functools
import json
import threading
from collections.abc import Iterator
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote

import pytest
from playwright.sync_api import Page, Route, sync_playwright


REPO_ROOT = Path(__file__).resolve().parents[1]
STATIC_ROOT = REPO_ROOT / "dist"
PORTFOLIO_PATH = "/jin_kim_portfolio.html"
VIDEO_PATH = "/%EB%91%90%EB%AF%B8%EB%8B%88%EC%96%B4%EB%8B%88%EC%96%B8/DoMiniOnion_Trailer.mp4"
POSTER_PATH = "/%EB%91%90%EB%AF%B8%EB%8B%88%EC%96%B4%EB%8B%88%EC%96%B8/DoMiniOnion_Trailer_poster.jpg"
CONFIGURATION = json.loads(
    (REPO_ROOT / "config" / "portfolio-manifest.json").read_text(encoding="utf-8")
)


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
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        yield page
        browser.close()


def asset_url(source_path: str) -> str:
    return "/" + "/".join(quote(segment, safe="") for segment in source_path.split("/"))


def public_manifest() -> dict[str, object]:
    projects: list[dict[str, object]] = []
    for project in CONFIGURATION["projects"]:
        if project["protected"]:
            projects.append(
                {
                    "id": project["id"],
                    "title": project["title"],
                    "protected": True,
                    "locked": True,
                    "itemCount": len(project["items"]),
                    "items": [
                        {
                            "id": f"locked-{project['id']}-{index}",
                            "title": "비공개 작품",
                            "type": "locked",
                            "locked": True,
                        }
                        for index in range(1, len(project["items"]) + 1)
                    ],
                }
            )
            continue

        items = []
        for item in project["items"]:
            display_item = {
                "id": item["id"],
                "title": item["title"],
                "category": project["title"],
                "type": item["type"],
                "description": item.get(
                    "description", f"{project['title']} · {item['title']}"
                ),
                "url": asset_url(item["sourcePath"]),
            }
            if "posterPath" in item:
                display_item["poster"] = asset_url(item["posterPath"])
            items.append(display_item)
        projects.append(
            {
                "id": project["id"],
                "title": project["title"],
                "protected": False,
                "locked": False,
                "itemCount": len(items),
                "items": items,
            }
        )
    return {"authenticated": False, "projects": projects}


def install_public_api(page: Page) -> None:
    manifest = public_manifest()

    def route_api(route: Route) -> None:
        path = route.request.url.split("?", 1)[0]
        if path.endswith("/api/auth/session"):
            route.fulfill(status=200, json={"authenticated": False})
        elif path.endswith("/api/auth/logout"):
            route.fulfill(status=204)
        elif path.endswith("/api/projects"):
            route.fulfill(status=200, json=manifest)
        else:
            route.fulfill(status=404, json={"error": "Not found"})

    page.route("**/api/**", route_api)


def enter_public(page: Page, portfolio_url: str) -> None:
    install_public_api(page)
    page.goto(portfolio_url, wait_until="domcontentloaded")
    page.get_by_role("button", name="공개 포트폴리오", exact=True).click()
    page.locator("#gallery-shell").wait_for(state="visible")


def test_public_resume_still_loads(page: Page, portfolio_url: str) -> None:
    page.goto(portfolio_url.rsplit(PORTFOLIO_PATH, 1)[0] + "/", wait_until="domcontentloaded")
    assert page.get_by_role("heading", name="김연규 (JIN KIM)", exact=True).is_visible()


@pytest.mark.parametrize("viewport", [(1440, 900), (390, 844), (320, 568)])
def test_public_resume_has_no_horizontal_overflow(
    page: Page, portfolio_url: str, viewport: tuple[int, int]
) -> None:
    width, height = viewport
    page.set_viewport_size({"width": width, "height": height})
    page.goto(portfolio_url.rsplit(PORTFOLIO_PATH, 1)[0] + "/", wait_until="domcontentloaded")

    assert page.evaluate(
        "document.documentElement.scrollWidth <= document.documentElement.clientWidth"
    )


def test_dominionion_category_uses_local_trailer(page: Page, portfolio_url: str) -> None:
    failed_responses: list[tuple[int, str]] = []
    origin = portfolio_url.rsplit(PORTFOLIO_PATH, 1)[0]
    page.on(
        "response",
        lambda response: failed_responses.append((response.status, response.url))
        if response.status >= 400 and response.url.startswith(origin)
        else None,
    )

    enter_public(page, portfolio_url)

    new_tab = page.get_by_role("button", name="두미니어니언", exact=True)
    assert new_tab.count() == 1
    assert page.get_by_role("button", name="도미니어니언", exact=True).count() == 0

    new_tab.click()
    cards = page.locator("#gallery-grid > button")
    assert cards.count() == 1

    thumbnail = cards.locator("video")
    assert thumbnail.count() == 1
    assert thumbnail.evaluate("video => new URL(video.src).pathname") == VIDEO_PATH
    assert thumbnail.evaluate("video => new URL(video.poster).pathname") == POSTER_PATH
    assert thumbnail.get_attribute("preload") == "none"
    assert thumbnail.evaluate("video => video.muted && video.playsInline")

    cards.first.click()
    modal = page.locator("#detail-modal")
    assert modal.is_visible()
    assert modal.get_attribute("role") == "dialog"
    assert modal.get_attribute("aria-modal") == "true"
    trailer = modal.locator("video[controls]")
    assert trailer.count() == 1
    assert trailer.evaluate("video => new URL(video.src).pathname") == VIDEO_PATH
    assert trailer.evaluate("video => new URL(video.poster).pathname") == POSTER_PATH
    assert trailer.evaluate("video => video.playsInline")

    trailer.evaluate(
        "video => video.readyState >= 1 || new Promise((resolve, reject) => {"
        "  video.addEventListener('loadedmetadata', resolve, { once: true });"
        "  video.addEventListener('error', () => reject(new Error('video metadata failed')), { once: true });"
        "})"
    )
    metadata = trailer.evaluate(
        "video => ({ duration: video.duration, width: video.videoWidth, height: video.videoHeight })"
    )
    assert metadata["duration"] == pytest.approx(72.149, abs=0.2)
    assert metadata["width"] == 1920
    assert metadata["height"] == 1080
    assert failed_responses == []


@pytest.mark.parametrize(
    ("category", "expected_count"),
    [("개인작", 16), ("워헤이븐", 23), ("왕좌의게임", 40)],
)
def test_existing_public_image_categories_still_load(
    page: Page, portfolio_url: str, category: str, expected_count: int
) -> None:
    failed_responses: list[tuple[int, str]] = []
    origin = portfolio_url.rsplit(PORTFOLIO_PATH, 1)[0]
    page.on(
        "response",
        lambda response: failed_responses.append((response.status, response.url))
        if response.status >= 400 and response.url.startswith(origin)
        else None,
    )

    enter_public(page, portfolio_url)
    page.get_by_role("button", name=category, exact=True).click()
    images = page.locator("#gallery-grid img")
    assert images.count() == expected_count
    images.evaluate_all("nodes => nodes.forEach(image => image.loading = 'eager')")
    page.wait_for_function(
        "() => [...document.querySelectorAll('#gallery-grid img')].every(image => image.complete)",
        timeout=60_000,
    )
    assert images.evaluate_all("nodes => nodes.every(image => image.naturalWidth > 0)")
    assert failed_responses == []


def test_viewer_keyboard_swipe_focus_trap_and_focus_restore(
    page: Page, portfolio_url: str
) -> None:
    enter_public(page, portfolio_url)
    first_card = page.locator("#gallery-grid > button").first
    first_card.focus()
    first_card.click()

    modal = page.locator("#detail-modal")
    assert modal.is_visible()
    assert page.locator("#modal-close-button").evaluate("element => element === document.activeElement")
    assert page.locator("#modal-title").text_content() == "1"

    page.keyboard.press("ArrowRight")
    assert page.locator("#modal-title").text_content() == "2"
    page.keyboard.press("ArrowLeft")
    assert page.locator("#modal-title").text_content() == "1"

    modal.evaluate(
        """element => {
            const start = new Touch({ identifier: 1, target: element, clientX: 280, clientY: 200 });
            const end = new Touch({ identifier: 1, target: element, clientX: 100, clientY: 205 });
            element.dispatchEvent(new TouchEvent('touchstart', { touches: [start], bubbles: true }));
            element.dispatchEvent(new TouchEvent('touchend', { changedTouches: [end], bubbles: true }));
        }"""
    )
    assert page.locator("#modal-title").text_content() == "2"

    page.locator("#modal-close-button").focus()
    page.keyboard.press("Shift+Tab")
    assert page.locator("#next-button").evaluate("element => element === document.activeElement")
    page.keyboard.press("Tab")
    assert page.locator("#modal-close-button").evaluate(
        "element => element === document.activeElement"
    )
    page.keyboard.press("Escape")
    assert modal.is_hidden()
    assert first_card.evaluate("element => element === document.activeElement")


def test_contact_dialog_traps_focus_closes_with_escape_and_restores_focus(
    page: Page, portfolio_url: str
) -> None:
    enter_public(page, portfolio_url)
    contact_button = page.get_by_role("button", name="Contact", exact=True)
    contact_button.click()

    dialog = page.get_by_role("dialog", name="Get in Touch")
    assert dialog.is_visible()
    assert dialog.get_attribute("aria-modal") == "true"
    close_button = page.get_by_role("button", name="연락처 닫기")
    page.wait_for_function(
        "document.querySelector('#contact-close-button') === document.activeElement"
    )
    assert close_button.evaluate("element => element === document.activeElement")

    page.keyboard.press("Shift+Tab")
    assert dialog.get_by_role("link").evaluate(
        "element => element === document.activeElement"
    )
    page.keyboard.press("Tab")
    assert close_button.evaluate("element => element === document.activeElement")
    page.keyboard.press("Escape")

    assert dialog.is_hidden()
    assert contact_button.evaluate("element => element === document.activeElement")


@pytest.mark.parametrize("viewport", [(1440, 900), (768, 1024), (390, 844), (320, 568)])
def test_entrance_gallery_and_video_viewer_have_no_horizontal_overflow(
    page: Page, portfolio_url: str, viewport: tuple[int, int]
) -> None:
    width, height = viewport
    page.set_viewport_size({"width": width, "height": height})
    install_public_api(page)
    page.goto(portfolio_url, wait_until="domcontentloaded")
    assert page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")

    page.get_by_role("button", name="면접용 전체 포트폴리오", exact=True).click()
    assert page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")
    page.get_by_role("button", name="선택으로 돌아가기", exact=True).click()
    page.get_by_role("button", name="공개 포트폴리오", exact=True).click()
    page.locator("#gallery-shell").wait_for(state="visible")
    assert page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")

    page.get_by_role("button", name="두미니어니언", exact=True).click()
    card = page.locator("#gallery-grid > button")
    assert card.count() == 1
    card.click()

    modal_box = page.locator("#detail-modal").bounding_box()
    video_box = page.locator("#modal-media-container video").bounding_box()
    assert modal_box is not None and modal_box["width"] == pytest.approx(width, abs=1)
    assert modal_box["height"] == pytest.approx(height, abs=1)
    assert video_box is not None and video_box["width"] <= width
    assert video_box["height"] <= height
    assert page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")
