#!/usr/bin/env python3
"""Write one versioned session-signing secret to stdout without storing it."""

from __future__ import annotations

import base64
import os


def base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


if __name__ == "__main__":
    print(f"session-v1${base64url(os.urandom(32))}")
