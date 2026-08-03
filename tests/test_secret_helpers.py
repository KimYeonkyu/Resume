from __future__ import annotations

import base64
import hashlib
import hmac
import os
import pty
import re
import select
import subprocess
import sys
import time
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
VERIFIER_PATTERN = re.compile(
    rb"PORTFOLIO_PASSWORD_VERIFIER=hmac-sha256-v1\$([A-Za-z0-9_-]{43})"
)
PEPPER_PATTERN = re.compile(
    rb"PORTFOLIO_PASSWORD_PEPPER=pepper-v1\$([A-Za-z0-9_-]{43})"
)
SESSION_PATTERN = re.compile(r"session-v1\$([A-Za-z0-9_-]{43})")


def read_until(master_fd: int, marker: bytes, output: bytearray) -> None:
    deadline = time.monotonic() + 10
    while marker not in output:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            pytest.fail("Timed out waiting for the no-echo helper prompt", pytrace=False)
        readable, _, _ = select.select([master_fd], [], [], remaining)
        if readable:
            output.extend(os.read(master_fd, 4096))


def collect_until_exit(child_pid: int, master_fd: int, output: bytearray) -> int:
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        exited_pid, status = os.waitpid(child_pid, os.WNOHANG)
        readable, _, _ = select.select([master_fd], [], [], 0.1)
        if readable:
            try:
                output.extend(os.read(master_fd, 4096))
            except OSError:
                pass
        if exited_pid == child_pid:
            return status
    os.kill(child_pid, 9)
    os.waitpid(child_pid, 0)
    pytest.fail("No-echo helper did not exit after confirmation", pytrace=False)


def test_password_secret_helper_reads_twice_without_echo_and_writes_no_file(
    tmp_path: Path,
) -> None:
    entered_password = b"V" * 8
    child_pid, master_fd = pty.fork()
    if child_pid == 0:
        os.chdir(tmp_path)
        os.execv(
            sys.executable,
            [sys.executable, str(REPO_ROOT / "scripts" / "generate-password-secrets.py")],
        )

    output = bytearray()
    try:
        read_until(master_fd, b"Portfolio password", output)
        os.write(master_fd, entered_password + b"\n")
        read_until(master_fd, b"Confirm password", output)
        os.write(master_fd, entered_password + b"\n")
        status = collect_until_exit(child_pid, master_fd, output)
    finally:
        os.close(master_fd)

    assert os.waitstatus_to_exitcode(status) == 0
    if entered_password in output:
        pytest.fail("Password helper echoed credential input", pytrace=False)
    verifier_match = VERIFIER_PATTERN.search(output)
    pepper_match = PEPPER_PATTERN.search(output)
    if verifier_match is None or pepper_match is None:
        pytest.fail("Password helper did not emit both versioned envelopes", pytrace=False)
    verifier = base64.urlsafe_b64decode(verifier_match.group(1) + b"=")
    pepper = base64.urlsafe_b64decode(pepper_match.group(1) + b"=")
    expected = hmac.new(pepper, entered_password, hashlib.sha256).digest()
    if not hmac.compare_digest(verifier, expected):
        pytest.fail("Password helper produced an invalid keyed verifier", pytrace=False)
    assert list(tmp_path.iterdir()) == []


def test_session_secret_helper_outputs_one_versioned_value_and_writes_no_file(
    tmp_path: Path,
) -> None:
    result = subprocess.run(
        [sys.executable, str(REPO_ROOT / "scripts" / "generate-session-secret.py")],
        cwd=tmp_path,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0
    generated = result.stdout.strip()
    if SESSION_PATTERN.fullmatch(generated) is None or result.stderr:
        pytest.fail("Session helper output was not one versioned secret", pytrace=False)
    assert list(tmp_path.iterdir()) == []


def test_password_secret_helper_rejects_a_short_password_without_echo(
    tmp_path: Path,
) -> None:
    entered_password = b"V" * 7
    child_pid, master_fd = pty.fork()
    if child_pid == 0:
        os.chdir(tmp_path)
        os.execv(
            sys.executable,
            [sys.executable, str(REPO_ROOT / "scripts" / "generate-password-secrets.py")],
        )

    output = bytearray()
    try:
        read_until(master_fd, b"Portfolio password", output)
        os.write(master_fd, entered_password + b"\n")
        read_until(master_fd, b"Confirm password", output)
        os.write(master_fd, entered_password + b"\n")
        status = collect_until_exit(child_pid, master_fd, output)
    finally:
        os.close(master_fd)

    assert os.waitstatus_to_exitcode(status) == 1
    if entered_password in output:
        pytest.fail("Password helper echoed credential input", pytrace=False)
    assert VERIFIER_PATTERN.search(output) is None
    assert PEPPER_PATTERN.search(output) is None
    assert list(tmp_path.iterdir()) == []
