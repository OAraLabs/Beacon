#!/usr/bin/env python3
"""Generate the macOS menu-bar (tray) glyph — the Beacon "Pulse" mark: a filled core inside two
concentric ping rings. Pure stdlib, no deps. Emits base64 PNGs for src/main/tray-icon.ts.

Menu-bar icons are 16pt; we ship @1x (16px) + @2x (32px) representations. On macOS the TEMPLATE
variant (black + alpha) is recolored by the system to match a light/dark bar; other platforms get
the SANGUINE variant so the glyph stays visible on their trays. Re-run after a design change:

    python3 scripts/make-tray-icon.py            # prints the four base64 blobs for tray-icon.ts
    python3 scripts/make-tray-icon.py --preview   # also writes PNGs to build/ for eyeballing
"""
from __future__ import annotations

import base64
import math
import os
import struct
import sys
import zlib

SANG = (184, 71, 58)  # --sang; the colored (non-mac) variant
SS = 4  # supersampling factor per axis (16 subsamples/pixel → clean edges at 16px)

# Pulse geometry, as fractions of the icon size (matches the mockup's proportions, nudged for presence).
CORE_R = 0.120
RING1_R, RING1_HW = 0.250, 0.035
RING2_R, RING2_HW, RING2_A = 0.400, 0.028, 0.5


def coverage(px: float, py: float, n: int) -> float:
    """Averaged alpha (0..1) for one output pixel via SS×SS supersampling."""
    c = n / 2.0
    acc = 0.0
    for sy in range(SS):
        for sx in range(SS):
            x = px + (sx + 0.5) / SS
            y = py + (sy + 0.5) / SS
            d = math.hypot(x - c, y - c) / n  # normalized distance from centre
            if d <= CORE_R or abs(d - RING1_R) <= RING1_HW:
                acc += 1.0
            elif abs(d - RING2_R) <= RING2_HW:
                acc += RING2_A
    return acc / (SS * SS)


def render(n: int, rgb: tuple[int, int, int]) -> bytes:
    raw = bytearray()
    for y in range(n):
        raw.append(0)  # PNG filter byte (None) per scanline
        for x in range(n):
            a = coverage(x, y, n)
            raw += bytes((rgb[0], rgb[1], rgb[2], int(a * 255 + 0.5)))
    return raw


def png(n: int, rgb: tuple[int, int, int]) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    out = b"\x89PNG\r\n\x1a\n"
    out += chunk(b"IHDR", struct.pack(">IIBBBBB", n, n, 8, 6, 0, 0, 0))  # 8-bit RGBA
    out += chunk(b"IDAT", zlib.compress(bytes(render(n, rgb)), 9))
    out += chunk(b"IEND", b"")
    return out


def main() -> None:
    variants = {
        "TEMPLATE_16": (16, (0, 0, 0)),
        "TEMPLATE_32": (32, (0, 0, 0)),
        "SANG_16": (16, SANG),
        "SANG_32": (32, SANG),
    }
    blobs = {name: png(n, rgb) for name, (n, rgb) in variants.items()}
    for name, data in blobs.items():
        print(f"{name} = {base64.b64encode(data).decode()}")
    if "--preview" in sys.argv:
        os.makedirs("build", exist_ok=True)
        for name, data in blobs.items():
            with open(f"build/tray-{name.lower()}.png", "wb") as f:
                f.write(data)
        print("\nwrote build/tray-*.png for preview", file=sys.stderr)


if __name__ == "__main__":
    main()
