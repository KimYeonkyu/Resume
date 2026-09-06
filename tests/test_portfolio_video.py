# pyright: reportMissingImports=false
from __future__ import annotations

import functools
import hashlib
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
VIDEO_SOURCE_PATH = "두미니어니언/DoMiniOnion_Trailer.mp4"
POSTER_SOURCE_PATH = "두미니어니언/DoMiniOnion_Trailer_poster.jpg"
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
    encoded = "/".join(quote(segment, safe="") for segment in source_path.split("/"))
    return f"/{encoded}?v={asset_version(source_path)}"


def asset_version(source_path: str) -> str:
    return hashlib.sha256((REPO_ROOT / source_path).read_bytes()).hexdigest()


def public_manifest() -> dict[str, object]:
    projects: list[dict[str, object]] = []
    for project in CONFIGURATION["projects"]:
        items = []
        has_protected_items = False
        for index, item in enumerate(project["items"], start=1):
            is_protected = bool(project["protected"] or item.get("protected", False))
            if is_protected:
                has_protected_items = True
                items.append(
                    {
                        "id": f"locked-{project['id']}-{index}",
                        "title": "비공개 작품",
                        "type": "locked",
                        "locked": True,
                    }
                )
                continue
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
                "protected": has_protected_items,
                "locked": has_protected_items,
                "itemCount": len(items),
                "items": items,
            }
        )
    return {"authenticated": False, "projects": projects}


def install_public_api(page: Page, manifest_override: dict[str, object] | None = None) -> None:
    manifest = manifest_override or public_manifest()

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


def enter_public(
    page: Page,
    portfolio_url: str,
    manifest_override: dict[str, object] | None = None,
) -> None:
    install_public_api(page, manifest_override)
    page.goto(portfolio_url, wait_until="domcontentloaded")
    page.get_by_role("button", name="공개 포트폴리오", exact=True).press("Enter")
    page.locator("#gallery-shell").wait_for(state="visible")


def assert_caption_below_rendered_media(page: Page) -> None:
    media = page.locator("#modal-media-container > img, #modal-media-container > video")
    caption = page.locator("#modal-info")
    media.wait_for(state="visible")
    media_box = media.bounding_box()
    caption_box = caption.bounding_box()
    viewport = page.viewport_size
    assert media_box is not None and caption_box is not None and viewport is not None
    assert media_box["y"] + media_box["height"] <= caption_box["y"] + 0.5
    assert caption_box["y"] + caption_box["height"] <= viewport["height"] + 0.5


def assert_media_and_caption_group_is_vertically_centered(page: Page) -> None:
    media = page.locator("#modal-media-container > img, #modal-media-container > video")
    caption = page.locator("#modal-info")
    media_box = media.bounding_box()
    caption_box = caption.bounding_box()
    viewport = page.viewport_size
    assert media_box is not None and caption_box is not None and viewport is not None
    group_center = (media_box["y"] + caption_box["y"] + caption_box["height"]) / 2
    assert group_center == pytest.approx(viewport["height"] / 2, abs=max(2, viewport["height"] * 0.02))


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
    assert thumbnail.evaluate("video => new URL(video.src).searchParams.get('v')") == asset_version(
        VIDEO_SOURCE_PATH
    )
    assert thumbnail.evaluate("video => new URL(video.poster).pathname") == POSTER_PATH
    assert thumbnail.evaluate(
        "video => new URL(video.poster).searchParams.get('v')"
    ) == asset_version(POSTER_SOURCE_PATH)
    assert thumbnail.get_attribute("preload") == "none"
    assert thumbnail.evaluate("video => video.muted && video.playsInline")
    frame_box = cards.first.locator(".artwork-frame").bounding_box()
    assert frame_box is not None
    assert frame_box["width"] / frame_box["height"] == pytest.approx(1.6, abs=0.03)

    cards.first.click()
    modal = page.locator("#detail-modal")
    assert modal.is_visible()
    assert modal.get_attribute("role") == "dialog"
    assert modal.get_attribute("aria-modal") == "true"
    trailer = modal.locator("video[controls]")
    assert trailer.count() == 1
    assert trailer.evaluate("video => new URL(video.src).pathname") == VIDEO_PATH
    assert trailer.evaluate("video => new URL(video.src).searchParams.get('v')") == asset_version(
        VIDEO_SOURCE_PATH
    )
    assert trailer.evaluate("video => new URL(video.poster).pathname") == POSTER_PATH
    assert trailer.evaluate(
        "video => new URL(video.poster).searchParams.get('v')"
    ) == asset_version(POSTER_SOURCE_PATH)
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

    trailer.evaluate("video => { video.dataset.viewerInstance = 'original'; }")
    trailer.focus()
    page.keyboard.press("ArrowRight")
    assert trailer.get_attribute("data-viewer-instance") == "original"

    page.locator("#modal-close-button").focus()
    page.keyboard.press("Shift+Tab")
    assert trailer.evaluate("video => video === document.activeElement")
    trailer_handle = trailer.element_handle()
    assert trailer_handle is not None
    page.locator("#modal-close-button").click()
    teardown = trailer_handle.evaluate(
        "video => ({ connected: video.isConnected, src: video.getAttribute('src'), paused: video.paused })"
    )
    assert teardown == {"connected": False, "src": None, "paused": True}
    assert failed_responses == []


def test_viewer_shows_one_persistent_identity_line_without_a_gradient(
    page: Page, portfolio_url: str
) -> None:
    enter_public(page, portfolio_url)
    page.locator("#gallery-grid > button").nth(16).click()

    modal = page.locator("#detail-modal")
    caption = modal.locator("#modal-info")
    caption_line = caption.locator("#modal-title")
    assert caption_line.inner_text() == "개인작 17"
    assert caption.locator(":visible").count() == 1
    assert caption.evaluate("element => getComputedStyle(element).backgroundImage") == "none"
    for pseudo in ("::before", "::after"):
        assert caption.evaluate(
            "(element, pseudo) => getComputedStyle(element, pseudo).backgroundImage",
            pseudo,
        ) == "none"
    assert caption_line.evaluate("element => getComputedStyle(element).whiteSpace") == "nowrap"
    assert_caption_below_rendered_media(page)

    page.wait_for_timeout(3_200)
    assert caption_line.is_visible()
    assert caption.evaluate("element => getComputedStyle(element).opacity") == "1"
    assert caption_line.inner_text() == "개인작 17"


def test_every_personal_item_navigation_reuses_the_caption_below_media_layout(
    page: Page, portfolio_url: str
) -> None:
    enter_public(page, portfolio_url)
    page.locator("#gallery-grid > button").first.click()

    modal = page.locator("#detail-modal")
    for artwork_number in range(1, 24):
        assert modal.locator(".viewer-content > #modal-media-container").count() == 1
        assert modal.locator(".viewer-content > #modal-info").count() == 1
        assert modal.locator("#modal-title").inner_text() == f"개인작 {artwork_number}"
        assert_caption_below_rendered_media(page)
        modal.locator("#next-button").click()

    assert modal.locator("#modal-title").inner_text() == "개인작 1"
    modal.locator("#modal-close-button").click()

    page.get_by_role("button", name="Project MP", exact=True).click()
    page.locator("#gallery-grid .artwork-card").click()
    assert modal.locator("#modal-title").inner_text() == "Project MP · 24"
    assert modal.locator("#modal-info").inner_text().count("Project MP") == 1
    assert_caption_below_rendered_media(page)


def test_viewer_identity_deduplicates_case_and_supported_category_boundaries(
    page: Page, portfolio_url: str
) -> None:
    source_path = "개인작/1.jpg"
    titles = ["project mp", "Project MP•24", "Project MP / 28", "27"]
    manifest = {
        "authenticated": False,
        "projects": [
            {
                "id": "identity-cases",
                "title": "Project MP",
                "protected": False,
                "locked": False,
                "itemCount": len(titles),
                "items": [
                    {
                        "id": f"identity-{index}",
                        "title": title,
                        **({} if title == "27" else {"category": "Project MP"}),
                        "type": "image",
                        "url": asset_url(source_path),
                    }
                    for index, title in enumerate(titles)
                ],
            }
        ],
    }
    enter_public(page, portfolio_url, manifest)
    page.locator("#gallery-grid > button").first.click()

    expected = ["project mp", "Project MP•24", "Project MP / 28", "Project MP 27"]
    for index, caption in enumerate(expected):
        assert page.locator("#modal-title").inner_text() == caption
        assert page.locator("#modal-info").inner_text().casefold().count("project mp") == 1
        if index + 1 < len(expected):
            page.locator("#next-button").click()


@pytest.mark.parametrize(
    "viewport",
    [
        (1440, 1000),
        (768, 1024),
        (390, 844),
        (320, 568),
        (1920, 500),
        (1024, 300),
        (844, 320),
    ],
)
def test_image_and_video_viewers_fit_caption_below_media_at_key_viewports(
    page: Page, portfolio_url: str, viewport: tuple[int, int]
) -> None:
    width, height = viewport
    page.set_viewport_size({"width": width, "height": height})
    enter_public(page, portfolio_url)

    page.locator("#gallery-grid > button").nth(1).click()
    assert page.locator("#modal-title").inner_text() == "개인작 2"
    assert_caption_below_rendered_media(page)
    assert_media_and_caption_group_is_vertically_centered(page)
    page.locator("#modal-close-button").click()

    page.get_by_role("button", name="두미니어니언", exact=True).click()
    page.locator("#gallery-grid > button").click()
    assert page.locator("#modal-title").inner_text() == "두미니어니언 DoMiniOnion Trailer"
    assert_caption_below_rendered_media(page)
    assert_media_and_caption_group_is_vertically_centered(page)
    assert page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")


def test_viewer_constrains_an_unusually_long_caption_to_the_mobile_viewport(
    page: Page, portfolio_url: str
) -> None:
    page.set_viewport_size({"width": 320, "height": 568})
    enter_public(page, portfolio_url)
    page.locator("#gallery-grid > button").first.click()

    caption = page.locator("#modal-info")
    caption_line = caption.locator("#modal-title")
    caption_line.evaluate("element => { element.textContent = '긴 제목 '.repeat(120); }")
    caption_box = caption.bounding_box()
    line_box = caption_line.bounding_box()
    assert caption_box is not None and line_box is not None
    assert caption_box["x"] >= 12
    assert caption_box["x"] + caption_box["width"] <= 308
    assert line_box["x"] >= 12
    assert line_box["x"] + line_box["width"] <= 308
    assert caption_line.evaluate("element => element.scrollWidth > element.clientWidth")
    assert caption_line.evaluate("element => getComputedStyle(element).textOverflow") == "ellipsis"
    assert page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth")


@pytest.mark.parametrize(
    ("category", "expected_image_count", "expected_locked_count"),
    [("개인작", 23, 0), ("워헤이븐", 13, 10), ("왕좌의게임", 40, 0)],
)
def test_existing_public_image_categories_still_load(
    page: Page,
    portfolio_url: str,
    category: str,
    expected_image_count: int,
    expected_locked_count: int,
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
    locked_cards = page.locator('#gallery-grid [data-locked="true"]')
    assert images.count() == expected_image_count
    assert locked_cards.count() == expected_locked_count
    configured_project = next(
        project for project in CONFIGURATION["projects"] if project["title"] == category
    )
    public_items = [
        item
        for item in configured_project["items"]
        if not (configured_project["protected"] or item.get("protected", False))
    ]
    rendered_urls = images.evaluate_all(
        """nodes => nodes.map(image => ({
            path: decodeURIComponent(new URL(image.src).pathname),
            version: new URL(image.src).searchParams.get('v'),
        }))"""
    )
    assert [rendered["path"] for rendered in rendered_urls] == [
        f"/{item['sourcePath']}" for item in public_items
    ]
    assert [rendered["version"] for rendered in rendered_urls] == [
        asset_version(item["sourcePath"]) for item in public_items
    ]
    images.evaluate_all("nodes => nodes.forEach(image => image.loading = 'eager')")
    page.wait_for_function(
        "() => [...document.querySelectorAll('#gallery-grid img')].every(image => image.complete)",
        timeout=60_000,
    )
    assert images.evaluate_all("nodes => nodes.every(image => image.naturalWidth > 0)")
    frame_box = page.locator("#gallery-grid .artwork-frame").first.bounding_box()
    assert frame_box is not None
    assert frame_box["width"] / frame_box["height"] == pytest.approx(1.6, abs=0.03)
    if category == "개인작":
        personal_16 = page.locator("#gallery-grid > button").nth(15)
        personal_16.click()
        assert page.locator("#modal-title").text_content() == "개인작 16"
        detail = page.locator("#modal-media-container img")
        assert detail.evaluate("image => decodeURIComponent(new URL(image.src).pathname)") == (
            "/개인작/16.jpg"
        )
        assert detail.evaluate("image => new URL(image.src).searchParams.get('v')") == asset_version(
            "개인작/16.jpg"
        )
        page.locator("#modal-close-button").click()

        personal_18 = page.locator("#gallery-grid > button").nth(17)
        personal_18.click()
        assert page.locator("#modal-title").text_content() == "개인작 18"
        detail = page.locator("#modal-media-container img")
        assert detail.evaluate("image => decodeURIComponent(new URL(image.src).pathname)") == (
            "/개인작/18.jpg"
        )
        assert detail.evaluate("image => new URL(image.src).searchParams.get('v')") == asset_version(
            "개인작/18.jpg"
        )
        page.locator("#modal-close-button").click()

        for artwork_number in range(19, 24):
            card = page.locator("#gallery-grid > button").nth(artwork_number - 1)
            card.scroll_into_view_if_needed()
            card.click()
            assert page.locator("#modal-title").text_content() == f"개인작 {artwork_number}"
            detail = page.locator("#modal-media-container img")
            source_path = f"개인작/{artwork_number}.jpg"
            assert detail.evaluate(
                "image => decodeURIComponent(new URL(image.src).pathname)"
            ) == f"/{source_path}"
            assert detail.evaluate(
                "image => new URL(image.src).searchParams.get('v')"
            ) == asset_version(source_path)
            assert detail.evaluate("image => image.complete && image.naturalWidth > 0")
            page.locator("#modal-close-button").click()
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
    assert modal.get_attribute("aria-labelledby") == "modal-title"
    assert page.locator("#modal-close-button").evaluate("element => element === document.activeElement")
    assert page.locator("#modal-title").text_content() == "개인작 1"
    assert page.locator("#modal-media-container img").evaluate(
        "image => new URL(image.src).searchParams.get('v')"
    ) == asset_version("개인작/1.jpg")

    page.keyboard.press("ArrowRight")
    assert page.locator("#modal-title").text_content() == "개인작 2"
    assert page.locator("#modal-media-container img").evaluate(
        "image => new URL(image.src).searchParams.get('v')"
    ) == asset_version("개인작/2.jpg")
    page.keyboard.press("ArrowLeft")
    assert page.locator("#modal-title").text_content() == "개인작 1"

    modal.evaluate(
        """element => {
            const start = new Touch({ identifier: 1, target: element, clientX: 280, clientY: 200 });
            const end = new Touch({ identifier: 1, target: element, clientX: 100, clientY: 205 });
            element.dispatchEvent(new TouchEvent('touchstart', { touches: [start], bubbles: true }));
            element.dispatchEvent(new TouchEvent('touchend', { changedTouches: [end], bubbles: true }));
        }"""
    )
    assert page.locator("#modal-title").text_content() == "개인작 2"

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
    page.get_by_role("button", name="공개 포트폴리오", exact=True).press("Enter")
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
