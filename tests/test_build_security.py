from __future__ import annotations

import hashlib
import json
import os
import secrets
import subprocess
from pathlib import Path
from urllib.parse import quote


REPO_ROOT = Path(__file__).resolve().parents[1]
DIST = REPO_ROOT / "dist"
CONFIGURATION = json.loads(
    (REPO_ROOT / "config" / "portfolio-manifest.json").read_text(encoding="utf-8")
)


def run_npm(script: str, environment: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["npm", "run", script],
        cwd=REPO_ROOT,
        env={**os.environ, **(environment or {})},
        check=False,
        capture_output=True,
        text=True,
    )


def inventory(directory: Path) -> list[tuple[str, str]]:
    return [
        (
            path.relative_to(directory).as_posix(),
            hashlib.sha256(path.read_bytes()).hexdigest(),
        )
        for path in sorted(directory.rglob("*"))
        if path.is_file()
    ]


def test_build_is_deterministic_and_contains_only_public_assets() -> None:
    runtime_sentinels = {
        "PORTFOLIO_PASSWORD_HASH": secrets.token_urlsafe(48),
        "SESSION_SECRET": secrets.token_urlsafe(48),
    }
    first = run_npm("build", runtime_sentinels)
    assert first.returncode == 0, first.stderr
    first_inventory = inventory(DIST)

    second = run_npm("build", runtime_sentinels)
    assert second.returncode == 0, second.stderr
    assert inventory(DIST) == first_inventory

    assert (DIST / "index.html").is_file()
    assert (DIST / "jin_kim_portfolio.html").is_file()
    assert (DIST / "portfolio.js").is_file()
    assert (DIST / "portfolio.css").is_file()
    assert (DIST / "두미니어니언" / "DoMiniOnion_Trailer.mp4").is_file()

    for entry in DIST.rglob("*"):
        assert not entry.is_symlink()
    assert not (DIST / "src").exists()
    assert not (DIST / "config").exists()
    assert not (DIST / "tests").exists()

    for excluded_directory in CONFIGURATION["deploymentExclusions"]["directories"]:
        assert not (DIST / excluded_directory).exists()
    for excluded_file in CONFIGURATION["deploymentExclusions"]["files"]:
        assert not (DIST / excluded_file).exists()

    output_hashes = {digest for _, digest in first_inventory}
    protected_sources = [
        REPO_ROOT / item["sourcePath"]
        for project in CONFIGURATION["projects"]
        if project["protected"]
        for item in project["items"]
    ] + [
        REPO_ROOT / name for name in CONFIGURATION["deploymentExclusions"]["files"]
    ]
    for source in protected_sources:
        assert source.is_file()
        assert hashlib.sha256(source.read_bytes()).hexdigest() not in output_hashes

    combined_text = "\n".join(
        path.read_text(encoding="utf-8")
        for path in DIST.rglob("*")
        if path.is_file() and path.suffix.lower() in {".css", ".html", ".js", ".json"}
    )
    for project in CONFIGURATION["projects"]:
        if not project["protected"]:
            continue
        for item in project["items"]:
            encoded_path = "/".join(quote(part, safe="") for part in item["sourcePath"].split("/"))
            for forbidden in (item["sourcePath"], encoded_path, item["r2Key"], item["routeId"]):
                assert forbidden not in combined_text
    for sentinel in runtime_sentinels.values():
        assert sentinel not in combined_text

    check = run_npm("check:dist")
    assert check.returncode == 0, check.stderr


def test_wrangler_uses_worker_first_private_bindings_without_plaintext_secrets() -> None:
    configuration = json.loads((REPO_ROOT / "wrangler.jsonc").read_text(encoding="utf-8"))

    assert configuration["main"] == "src/worker.ts"
    assert configuration["assets"] == {
        "binding": "ASSETS",
        "directory": "./dist",
        "run_worker_first": True,
    }
    assert configuration["r2_buckets"][0]["binding"] == "PROTECTED_MEDIA"
    assert configuration["ratelimits"] == [
        {
            "name": "LOGIN_RATE_LIMITER",
            "namespace_id": "2026080201",
            "simple": {"limit": 10, "period": 60},
        }
    ]
    serialized_vars = json.dumps(configuration.get("vars", {}))
    assert "PORTFOLIO_PASSWORD_HASH" not in serialized_vars
    assert "SESSION_SECRET" not in serialized_vars


def test_r2_upload_helper_defaults_to_a_non_mutating_plan() -> None:
    result = subprocess.run(
        ["node", "scripts/upload-protected-media.mjs"],
        cwd=REPO_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    assert "24 protected objects" in result.stdout
    assert "No uploads performed" in result.stdout


def test_dist_checker_rejects_an_excluded_protected_filename_reference() -> None:
    build = run_npm("build")
    assert build.returncode == 0, build.stderr
    injected_file = DIST / "injected-protected-reference.js"
    injected_file.write_text(
        CONFIGURATION["deploymentExclusions"]["files"][0],
        encoding="utf-8",
    )

    try:
        check = run_npm("check:dist")
        assert check.returncode != 0
        assert "protected media metadata" in check.stderr
    finally:
        injected_file.unlink(missing_ok=True)


def test_dist_checker_decodes_protected_paths_despite_unrelated_percent_signs() -> None:
    build = run_npm("build")
    assert build.returncode == 0, build.stderr
    protected_project = next(
        project for project in CONFIGURATION["projects"] if project["protected"]
    )
    source_path = protected_project["items"][0]["sourcePath"]
    encoded_once = "/".join(quote(part, safe="") for part in source_path.split("/"))
    encoded_twice = "/".join(quote(part, safe="") for part in encoded_once.split("/"))
    injected_file = DIST / "injected-double-encoded-reference.css"
    injected_file.write_text(
        f'.decoy {{ width: 100%; background-image: url("{encoded_twice}"); }}',
        encoding="utf-8",
    )

    try:
        check = run_npm("check:dist")
        assert check.returncode != 0
        assert "protected media metadata" in check.stderr
    finally:
        injected_file.unlink(missing_ok=True)
