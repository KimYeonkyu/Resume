#!/usr/bin/env python3
"""Interactively produce the Cloudflare password-hash secret without persisting input."""

from __future__ import annotations

import base64
import getpass
import hashlib
import secrets
import sys


ITERATIONS = 600_000
MIN_PASSWORD_BYTES = 16
MAX_PASSWORD_BYTES = 256


def base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def main() -> int:
    try:
        password = getpass.getpass("Portfolio password: ")
        confirmation = getpass.getpass("Confirm password: ")
    except (EOFError, KeyboardInterrupt):
        print("Credential entry cancelled.", file=sys.stderr)
        return 1

    password_bytes = password.encode("utf-8")
    if password != confirmation:
        print("The two entries did not match.", file=sys.stderr)
        return 1
    if not MIN_PASSWORD_BYTES <= len(password_bytes) <= MAX_PASSWORD_BYTES:
        print("Password length is outside the accepted range.", file=sys.stderr)
        return 1

    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password_bytes, salt, ITERATIONS, dklen=32
    )
    print(
        f"pbkdf2-sha256${ITERATIONS}${base64url(salt)}${base64url(digest)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
