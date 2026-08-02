# pyright: reportMissingImports=false
from __future__ import annotations

import functools
import threading
from collections.abc import Iterator
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from playwright.sync_api import Page, sync_playwright


REPO_ROOT = Path(__file__).resolve().parents[1]
PORTFOLIO_PATH = "/jin_kim_portfolio.html"
VIDEO_PATH = "/%EB%91%90%EB%AF%B8%EB%8B%88%EC%96%B4%EB%8B%88%EC%96%B8/DoMiniOnion_Trailer.mp4"
POSTER_PATH = "/%EB%91%90%EB%AF%B8%EB%8B%88%EC%96%B4%EB%8B%88%EC%96%B8/DoMiniOnion_Trailer_poster.jpg"


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        pass


@pytest.fixture(scope="module")
def portfolio_url() -> Iterator[str]:
    handler = functools.partial(QuietHandler, directory=str(REPO_ROOT))
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


def test_dominionion_category_uses_local_trailer(page: Page, portfolio_url: str) -> None:
    failed_responses: list[tuple[int, str]] = []
    page.on(
        "response",
        lambda response: failed_responses.append((response.status, response.url))
        if response.status >= 400 and response.url.startswith(portfolio_url.rsplit(PORTFOLIO_PATH, 1)[0])
        else None,
    )

    page.goto(portfolio_url, wait_until="load")

    new_tab = page.get_by_role("button", name="두미니어니언", exact=True)
    new_tab.wait_for(state="attached")
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
    [
        ("개인작", 16),
        ("워헤이븐", 23),
        ("왕좌의게임", 40),
        ("Project MP", 6),
        ("Project DM", 18),
    ],
)
def test_existing_image_categories_still_load(
    page: Page, portfolio_url: str, category: str, expected_count: int
) -> None:
    failed_responses: list[tuple[int, str]] = []
    page.on(
        "response",
        lambda response: failed_responses.append((response.status, response.url))
        if response.status >= 400 and response.url.startswith(portfolio_url.rsplit(PORTFOLIO_PATH, 1)[0])
        else None,
    )

    page.goto(portfolio_url, wait_until="load")
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


@pytest.mark.parametrize("viewport", [(768, 1024), (390, 844), (320, 568)])
def test_dominionion_video_layout_fits_viewport(
    page: Page, portfolio_url: str, viewport: tuple[int, int]
) -> None:
    width, height = viewport
    page.set_viewport_size({"width": width, "height": height})
    page.goto(portfolio_url, wait_until="load")
    page.get_by_role("button", name="두미니어니언", exact=True).click()

    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
    card = page.locator("#gallery-grid > button")
    assert card.count() == 1
    card.click()

    modal_box = page.locator("#detail-modal").bounding_box()
    video_box = page.locator("#modal-media-container video").bounding_box()
    assert modal_box is not None and modal_box["width"] == pytest.approx(width, abs=1)
    assert modal_box["height"] == pytest.approx(height, abs=1)
    assert video_box is not None and video_box["width"] <= width
    assert video_box["height"] <= height
