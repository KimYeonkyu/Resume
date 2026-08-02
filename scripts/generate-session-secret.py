#!/usr/bin/env python3
"""Write a fresh session-signing secret to stdout without storing it."""

from __future__ import annotations

import secrets


if __name__ == "__main__":
    print(secrets.token_urlsafe(32))
