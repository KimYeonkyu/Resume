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
HASH_PATTERN = re.compile(
    rb"pbkdf2-sha256\$600000\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})"
)
SECRET_PATTERN = re.compile(r"[A-Za-z0-9_-]{43,}")


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


def test_password_hash_helper_reads_twice_without_echo_and_writes_no_file(
    tmp_path: Path,
) -> None:
    entered_password = base64.urlsafe_b64encode(os.urandom(30)).rstrip(b"=")
    child_pid, master_fd = pty.fork()
    if child_pid == 0:
        os.chdir(tmp_path)
        os.execv(
            sys.executable,
            [sys.executable, str(REPO_ROOT / "scripts" / "generate-password-hash.py")],
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
    match = HASH_PATTERN.search(output)
    if match is None:
        pytest.fail("Password helper did not emit the required hash envelope", pytrace=False)
    salt = base64.urlsafe_b64decode(match.group(1) + b"==")
    digest = base64.urlsafe_b64decode(match.group(2) + b"=")
    expected = hashlib.pbkdf2_hmac("sha256", entered_password, salt, 600_000, dklen=32)
    if not hmac.compare_digest(digest, expected):
        pytest.fail("Password helper produced an invalid derived value", pytrace=False)
    assert list(tmp_path.iterdir()) == []


def test_session_secret_helper_outputs_one_ephemeral_value_and_writes_no_file(
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
    if SECRET_PATTERN.fullmatch(generated) is None or result.stderr:
        pytest.fail("Session helper output was not a single valid secret", pytrace=False)
    assert list(tmp_path.iterdir()) == []


def test_password_hash_helper_rejects_a_short_password_without_echo(
    tmp_path: Path,
) -> None:
    entered_password = base64.urlsafe_b64encode(os.urandom(6)).rstrip(b"=")
    child_pid, master_fd = pty.fork()
    if child_pid == 0:
        os.chdir(tmp_path)
        os.execv(
            sys.executable,
            [sys.executable, str(REPO_ROOT / "scripts" / "generate-password-hash.py")],
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
    assert HASH_PATTERN.search(output) is None
    assert list(tmp_path.iterdir()) == []
