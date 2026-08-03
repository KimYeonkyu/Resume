#!/usr/bin/env python3
"""Interactively derive versioned password verifier material without writing files."""

from __future__ import annotations

import base64
import getpass
import hashlib
import hmac
import os
import sys


MIN_PASSWORD_BYTES = 8
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

    pepper = os.urandom(32)
    verifier = hmac.new(pepper, password_bytes, hashlib.sha256).digest()
    print(f"PORTFOLIO_PASSWORD_VERIFIER=hmac-sha256-v1${base64url(verifier)}")
    print(f"PORTFOLIO_PASSWORD_PEPPER=pepper-v1${base64url(pepper)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
