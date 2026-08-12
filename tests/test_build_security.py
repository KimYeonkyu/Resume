from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import unicodedata
from pathlib import Path
from typing import Any
from urllib.parse import quote


REPO_ROOT = Path(__file__).resolve().parents[1]
DIST = REPO_ROOT / "dist"
SERVER_DIST = REPO_ROOT / "server-dist"
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


def item_is_protected(project: dict[str, Any], item: dict[str, Any]) -> bool:
    return project["protected"] is True or item.get("protected") is True


def protected_items() -> list[dict[str, Any]]:
    return [
        item
        for project in CONFIGURATION["projects"]
        for item in project["items"]
        if item_is_protected(project, item)
    ]


def public_asset_paths() -> set[str]:
    paths: set[str] = set()
    for project in CONFIGURATION["projects"]:
        for item in project["items"]:
            if item_is_protected(project, item):
                continue
            paths.add(item["sourcePath"])
            if item.get("posterPath"):
                paths.add(item["posterPath"])
    return paths


def natural_filename_key(path: Path) -> tuple[tuple[int, int | str], ...]:
    normalized = unicodedata.normalize("NFKC", path.stem).casefold()
    return tuple(
        (0, int(part)) if part.isdigit() else (1, part)
        for part in re.split(r"(\d+)", normalized)
    )


def test_personal_manifest_matches_repository_image_identity_and_natural_order() -> None:
    personal = next(project for project in CONFIGURATION["projects"] if project["id"] == "personal")
    declared = [item["sourcePath"] for item in personal["items"]]
    actual = [
        path.relative_to(REPO_ROOT).as_posix()
        for path in sorted(
            (REPO_ROOT / "개인작").iterdir(),
            key=natural_filename_key,
        )
        if path.is_file() and path.suffix.casefold() in {".jpg", ".jpeg", ".png", ".webp"}
    ]

    assert declared == actual
    for item, source_path in zip(personal["items"], actual, strict=True):
        source_stem = Path(source_path).stem
        assert item["title"] == source_stem
        assert item["id"] == f"personal-{int(source_stem):02d}"


def combined_public_text() -> str:
    return "\n".join(
        path.read_text(encoding="utf-8")
        for path in DIST.rglob("*")
        if path.is_file() and path.suffix.lower() in {".css", ".html", ".js", ".json"}
    )


def test_build_is_deterministic_and_contains_only_public_assets() -> None:
    runtime_sentinels = {
        "PORTFOLIO_PASSWORD_VERIFIER": "hmac-sha256-v1$SENTINEL_VERIFIER_MUST_NOT_LEAK",
        "PORTFOLIO_PASSWORD_PEPPER": "pepper-v1$SENTINEL_PEPPER_MUST_NOT_LEAK",
        "SESSION_SECRET": "session-v1$SENTINEL_SESSION_MUST_NOT_LEAK",
    }
    first = run_npm("build", runtime_sentinels)
    assert first.returncode == 0, first.stderr
    first_inventory = inventory(DIST)

    second = run_npm("build", runtime_sentinels)
    assert second.returncode == 0, second.stderr
    assert inventory(DIST) == first_inventory

    for required in (
        "index.html",
        "jin_kim_portfolio.html",
        "jin-kim-cover.webp",
        "portfolio.js",
        "portfolio.css",
        "public-portfolio-manifest.json",
        "두미니어니언/DoMiniOnion_Trailer.mp4",
    ):
        assert (DIST / required).is_file()

    for entry in DIST.rglob("*"):
        assert not entry.is_symlink()
    for forbidden_directory in ("src", "config", "tests", ".git", ".wrangler"):
        assert not (DIST / forbidden_directory).exists()

    for excluded_directory in CONFIGURATION["deploymentExclusions"]["directories"]:
        assert not (DIST / excluded_directory).exists()
    for excluded_file in CONFIGURATION["deploymentExclusions"]["files"]:
        assert not (DIST / excluded_file).exists()

    for item in protected_items():
        assert not (REPO_ROOT / item["sourcePath"]).exists()
        assert not (DIST / item["sourcePath"]).exists()
    for relative_path in public_asset_paths():
        assert (REPO_ROOT / relative_path).is_file(), relative_path
        assert (DIST / relative_path).is_file(), relative_path

    public_text = combined_public_text()
    for item in protected_items():
        encoded_once = "/".join(quote(part, safe="") for part in item["sourcePath"].split("/"))
        encoded_twice = "/".join(quote(part, safe="") for part in encoded_once.split("/"))
        for forbidden in (
            item["sourcePath"],
            encoded_once,
            encoded_twice,
            item["routeId"],
            item["sha256"],
        ):
            assert forbidden not in public_text
    for sentinel in runtime_sentinels.values():
        assert sentinel not in public_text

    check = run_npm("check:dist")
    assert check.returncode == 0, check.stderr


def test_resume_stylesheet_url_is_relative_to_the_pages_project_path() -> None:
    source = (REPO_ROOT / "index.html").read_text(encoding="utf-8")
    assert 'href="./resume.css"' in source
    assert 'href="/resume.css"' not in source

    build = run_npm("build:public")
    assert build.returncode == 0, build.stderr
    published = (DIST / "index.html").read_text(encoding="utf-8")
    assert 'href="./resume.css"' in published
    assert 'href="/resume.css"' not in published


def test_resume_portfolio_button_links_to_the_protected_origin() -> None:
    source = (REPO_ROOT / "index.html").read_text(encoding="utf-8")
    assert (
        'href="https://minionion.duckdns.org/jin_kim_portfolio.html"'
        in source
    )
    assert 'href="https://jinkimdrawing.wixsite.com/concept"' not in source


def test_resume_nypc_result_link_opens_the_attached_public_pdf() -> None:
    expected_digest = "a2aa4c70ab62756bc0c1bb544d5c5561552fe3e21e99baca32d3fee3afa308cb"
    source = (REPO_ROOT / "index.html").read_text(encoding="utf-8")
    assert 'href="./NYPC%20ranking.pdf"' in source
    assert "nypc-static.s3.ap-northeast-2.amazonaws.com" not in source

    source_pdf = REPO_ROOT / "NYPC ranking.pdf"
    assert hashlib.sha256(source_pdf.read_bytes()).hexdigest() == expected_digest

    build = run_npm("build:public")
    assert build.returncode == 0, build.stderr
    published_pdf = DIST / "NYPC ranking.pdf"
    assert hashlib.sha256(published_pdf.read_bytes()).hexdigest() == expected_digest


def test_self_hosted_runtime_has_no_cloudflare_deployment_path() -> None:
    for removed_path in (
        "wrangler.jsonc",
        "src/worker.ts",
        "vitest.worker.config.ts",
        "scripts/upload-protected-media.mjs",
        "docs/cloudflare-deployment.md",
    ):
        assert not (REPO_ROOT / removed_path).exists()

    package = json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8"))
    scripts = package["scripts"]
    for removed_script in ("deploy", "r2:upload", "test:worker", "test:runtime"):
        assert removed_script not in scripts
    assert scripts["start"] == "NODE_ENV=production node server-dist/server.mjs"
    assert (
        scripts["build:server"]
        == "npm run manifest:check && node scripts/build-server.mjs"
    )

    combined = "\n".join(
        path.read_text(encoding="utf-8")
        for path in (
            REPO_ROOT / "package.json",
            REPO_ROOT / ".github" / "workflows" / "ci.yml",
            REPO_ROOT / "docs" / "mac-mini-deployment.md",
        )
    )
    for forbidden in ("wrangler deploy", "test:worker", "test:runtime", "R2 bucket"):
        assert forbidden not in combined


def test_ci_deploys_only_the_verified_dist_artifact_to_github_pages() -> None:
    workflow = (REPO_ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    assert "actions/upload-pages-artifact@v3" in workflow
    assert "path: dist" in workflow
    assert "actions/deploy-pages@v4" in workflow
    assert "pages: read" in workflow
    assert "pages: write" in workflow
    assert "id-token: write" in workflow
    assert 'build_type=$(gh api "repos/${GITHUB_REPOSITORY}/pages" --jq .build_type)' in workflow
    assert 'if [ "$build_type" != "workflow" ]' in workflow
    assert workflow.index("npm run check:dist") < workflow.index("actions/upload-pages-artifact@v3")


def test_runbook_requires_pages_fail_closed_gate_before_protected_origin() -> None:
    runbook = (REPO_ROOT / "docs" / "mac-mini-deployment.md").read_text(encoding="utf-8")
    pages_gate = runbook.index("Publish and verify the guest-safe Pages build")
    protected_start = runbook.index("Start and verify the protected origin")
    assert pages_gate < protected_start
    assert "exact `dist/` artifact" in runbook
    assert "404` or `410" in runbook
    assert "disable GitHub Pages" in runbook
    assert "Do not expose the protected origin before this gate passes" in runbook
    assert "Before merging the release commit" in runbook
    assert "`build_type=workflow`" in runbook


def test_production_secrets_are_keychain_only_and_server_is_loopback_only() -> None:
    runtime_source = (REPO_ROOT / "src" / "runtime-config.ts").read_text(encoding="utf-8")
    server_source = (REPO_ROOT / "src" / "node-server.ts").read_text(encoding="utf-8")
    assert "Production secrets must come from macOS Keychain" in runtime_source
    assert '"/usr/bin/security"' in runtime_source
    assert "com.jinkim.portfolio.password-verifier" in runtime_source
    assert "com.jinkim.portfolio.password-pepper" in runtime_source
    assert "com.jinkim.portfolio.session-secret" in runtime_source
    assert 'host !== "127.0.0.1" && host !== "::1"' in server_source
    assert "Requests must arrive through the loopback reverse proxy" in server_source


def test_deployment_defaults_disable_caddy_admin_and_use_the_same_backend_port() -> None:
    runtime_source = (REPO_ROOT / "src" / "runtime-config.ts").read_text(encoding="utf-8")
    caddy_source = (REPO_ROOT / "deploy" / "Caddyfile.example").read_text(encoding="utf-8")
    assert 'integerSetting(environment, "PORTFOLIO_PORT", 8_794' in runtime_source
    assert "admin off" in caddy_source
    assert "reverse_proxy 127.0.0.1:8794" in caddy_source


def test_password_verification_is_versioned_keyed_and_constant_time() -> None:
    security_source = (REPO_ROOT / "src" / "security.ts").read_text(encoding="utf-8")
    assert 'createHmac("sha256", pepper)' in security_source
    assert "timingSafeEqual(candidate, expectedVerifier)" in security_source
    assert 'parseEnvelope(value, "hmac-sha256-v1")' in security_source
    assert 'parseEnvelope(value, "pepper-v1")' in security_source
    assert "PBKDF2" not in security_source
    assert "PORTFOLIO_PASSWORD_DIGEST" not in security_source


def test_standalone_server_build_rejects_stale_media_versions_before_bundle(
    tmp_path: Path,
) -> None:
    fixture = tmp_path / "repository"
    scripts_directory = fixture / "scripts"
    (fixture / "config").mkdir(parents=True)
    (fixture / "media").mkdir()
    scripts_directory.mkdir()

    source_package = json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8"))
    package = {
        "name": "public-media-build-server-regression",
        "version": "1.0.0",
        "private": True,
        "type": "module",
        "scripts": {
            "build:server": source_package["scripts"]["build:server"],
            "manifest:check": source_package["scripts"]["manifest:check"],
        },
    }
    (fixture / "package.json").write_text(json.dumps(package), encoding="utf-8")
    for script_name in ("generate-public-manifest.mjs", "public-manifest.mjs"):
        (scripts_directory / script_name).write_bytes(
            (REPO_ROOT / "scripts" / script_name).read_bytes()
        )
    (scripts_directory / "build-server.mjs").write_text(
        """import { mkdir, writeFile } from \"node:fs/promises\";
await mkdir(new URL(\"../server-dist/\", import.meta.url), { recursive: true });
await writeFile(new URL(\"../server-dist/server.mjs\", import.meta.url), \"untrusted bundle\\n\");
""",
        encoding="utf-8",
    )

    source_path = "media/asset.jpg"
    (fixture / source_path).write_bytes(b"current public bytes")
    (fixture / "config" / "portfolio-manifest.json").write_text(
        json.dumps(
            {
                "projects": [
                    {
                        "id": "synthetic",
                        "title": "Synthetic",
                        "protected": False,
                        "items": [
                            {
                                "id": "public",
                                "title": "Public",
                                "type": "image",
                                "sourcePath": source_path,
                            }
                        ],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    (fixture / "public-media-versions.json").write_text(
        json.dumps({source_path: "0" * 64}) + "\n",
        encoding="utf-8",
    )

    build = subprocess.run(
        ["npm", "run", "build:server"],
        cwd=fixture,
        check=False,
        capture_output=True,
        text=True,
    )

    assert build.returncode != 0
    assert "public-media-versions.json is stale" in build.stderr
    assert not (fixture / "server-dist" / "server.mjs").exists()


def test_server_bundle_builds_without_embedding_runtime_secret_values() -> None:
    sentinels = {
        "PORTFOLIO_PASSWORD_VERIFIER": "hmac-sha256-v1$BUILD_SENTINEL_VERIFIER",
        "PORTFOLIO_PASSWORD_PEPPER": "pepper-v1$BUILD_SENTINEL_PEPPER",
        "SESSION_SECRET": "session-v1$BUILD_SENTINEL_SESSION",
    }
    build = run_npm("build:server", sentinels)
    assert build.returncode == 0, build.stderr
    bundle = SERVER_DIST / "server.mjs"
    assert bundle.is_file() and not bundle.is_symlink()
    text = bundle.read_text(encoding="utf-8")
    for sentinel in sentinels.values():
        assert sentinel not in text


def test_public_repository_tree_contains_no_protected_source_media() -> None:
    assert len(protected_items()) == 33
    for item in protected_items():
        assert not (REPO_ROOT / item["sourcePath"]).exists(), item["sourcePath"]
    for file_name in CONFIGURATION["deploymentExclusions"]["files"]:
        assert not (REPO_ROOT / file_name).exists(), file_name


def test_every_excluded_protected_pdf_has_its_historical_byte_hash_pinned() -> None:
    expected = {
        "warhaven.pdf": "11e53d5a5adc96c42caed21aa01e4eaacba8cfaae3cdbccca5a6428ab097b7fe",
        "MP.pdf": "a93af17ca3718c94e62322bd007292a030cabea4f0d6feb903305c0dc0587488",
        "DM.pdf": "518ca3cf8cc89389b2e34174008c0cb067a7ef2350b33034fb367dff1c7c66bb",
    }
    exclusions = CONFIGURATION["deploymentExclusions"]
    assert exclusions["protectedFileHashes"] == expected
    assert {path for path in exclusions["files"] if path.lower().endswith(".pdf")} == set(expected)


def test_dist_checker_rejects_missing_public_media_version_key() -> None:
    build = run_npm("build:public")
    assert build.returncode == 0, build.stderr
    versions_path = REPO_ROOT / "public-media-versions.json"
    original = versions_path.read_bytes()
    modified = json.loads(original)
    modified.pop(sorted(modified)[0])
    try:
        versions_path.write_text(
            json.dumps(modified, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        check = run_npm("check:dist")
        assert check.returncode != 0
        assert "do not match configured public assets" in check.stderr
    finally:
        versions_path.write_bytes(original)


def test_dist_checker_rejects_extra_public_media_version_key() -> None:
    build = run_npm("build:public")
    assert build.returncode == 0, build.stderr
    versions_path = REPO_ROOT / "public-media-versions.json"
    original = versions_path.read_bytes()
    modified = json.loads(original)
    modified["media/unconfigured-extra.jpg"] = "0" * 64
    try:
        versions_path.write_text(
            json.dumps(modified, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        check = run_npm("check:dist")
        assert check.returncode != 0
        assert "do not match configured public assets" in check.stderr
    finally:
        versions_path.write_bytes(original)


def test_dist_checker_rejects_public_media_byte_mutation_at_valid_path() -> None:
    build = run_npm("build:public")
    assert build.returncode == 0, build.stderr
    source_path = sorted(public_asset_paths())[0]
    output_file = DIST / source_path
    original = output_file.read_bytes()
    output_file.write_bytes(original + b"\npublic-byte-mutation-regression\n")
    try:
        check = run_npm("check:dist")
        assert check.returncode != 0
        assert "generated SHA-256 version" in check.stderr
    finally:
        output_file.write_bytes(original)


def test_dist_checker_rejects_an_excluded_protected_filename_reference() -> None:
    build = run_npm("build:public")
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
    build = run_npm("build:public")
    assert build.returncode == 0, build.stderr
    source_path = protected_items()[0]["sourcePath"]
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


def test_dist_checker_rejects_item_level_protected_route_metadata() -> None:
    build = run_npm("build:public")
    assert build.returncode == 0, build.stderr
    selected_item = next(
        item
        for project in CONFIGURATION["projects"]
        for item in project["items"]
        if item.get("protected") is True
    )
    output_file = DIST / "portfolio.css"
    original = output_file.read_bytes()
    output_file.write_bytes(original + f"\n/* {selected_item['routeId']} */\n".encode())
    try:
        check = run_npm("check:dist")
        assert check.returncode != 0
        assert "protected media metadata" in check.stderr
    finally:
        output_file.write_bytes(original)


def test_dist_checker_rejects_protected_reference_in_an_arbitrary_extension() -> None:
    build = run_npm("build:public")
    assert build.returncode == 0, build.stderr
    injected_file = DIST / "injected-protected-reference.txt"
    injected_file.write_text(protected_items()[0]["sourcePath"], encoding="utf-8")
    try:
        check = run_npm("check:dist")
        assert check.returncode != 0
    finally:
        injected_file.unlink(missing_ok=True)


def test_dist_checker_rejects_protected_bytes_renamed_to_an_allowed_public_path() -> None:
    build = run_npm("build:public")
    assert build.returncode == 0, build.stderr
    manifest_path = REPO_ROOT / "config" / "portfolio-manifest.json"
    output_file = DIST / "portfolio.css"
    original_manifest = manifest_path.read_bytes()
    original_output = output_file.read_bytes()
    protected_bytes = b"synthetic protected media bytes without identifying text"
    modified = json.loads(original_manifest)
    selected = next(
        item
        for project in modified["projects"]
        for item in project["items"]
        if item_is_protected(project, item)
    )
    selected["sha256"] = hashlib.sha256(protected_bytes).hexdigest()
    try:
        manifest_path.write_text(json.dumps(modified, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        output_file.write_bytes(protected_bytes)
        check = run_npm("check:dist")
        assert check.returncode != 0
        assert "protected media bytes" in check.stderr
    finally:
        manifest_path.write_bytes(original_manifest)
        output_file.write_bytes(original_output)


def test_dist_checker_rejects_declared_protected_pdf_bytes_at_an_allowed_pdf_path() -> None:
    build = run_npm("build:public")
    assert build.returncode == 0, build.stderr
    manifest_path = REPO_ROOT / "config" / "portfolio-manifest.json"
    output_file = DIST / "GOT.pdf"
    original_manifest = manifest_path.read_bytes()
    original_output = output_file.read_bytes()
    protected_pdf = b"%PDF-1.7\nsynthetic protected aggregate\n%%EOF\n"
    modified = json.loads(original_manifest)
    modified["deploymentExclusions"]["protectedFileHashes"]["warhaven.pdf"] = hashlib.sha256(
        protected_pdf
    ).hexdigest()
    try:
        manifest_path.write_text(json.dumps(modified, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        output_file.write_bytes(protected_pdf)
        check = run_npm("check:dist")
        assert check.returncode != 0
        assert "protected media bytes" in check.stderr
    finally:
        manifest_path.write_bytes(original_manifest)
        output_file.write_bytes(original_output)


def test_dist_checker_requires_a_hash_for_every_excluded_pdf() -> None:
    build = run_npm("build:public")
    assert build.returncode == 0, build.stderr
    manifest_path = REPO_ROOT / "config" / "portfolio-manifest.json"
    original_manifest = manifest_path.read_bytes()
    modified = json.loads(original_manifest)
    modified["deploymentExclusions"]["protectedFileHashes"].pop("warhaven.pdf")
    try:
        manifest_path.write_text(json.dumps(modified, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        check = run_npm("check:dist")
        assert check.returncode != 0
        assert "missing protected hash" in check.stderr.lower()
    finally:
        manifest_path.write_bytes(original_manifest)


def test_dist_checker_rejects_every_unexpected_output_path() -> None:
    build = run_npm("build:public")
    assert build.returncode == 0, build.stderr
    protected_basename = Path(protected_items()[0]["sourcePath"]).name
    injected_file = DIST / protected_basename
    injected_file.write_bytes(b"synthetic-unrelated-bytes")
    try:
        check = run_npm("check:dist")
        assert check.returncode != 0
        assert "unexpected file" in check.stderr
    finally:
        injected_file.unlink(missing_ok=True)
