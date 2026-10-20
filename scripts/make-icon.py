#!/usr/bin/env python3
"""Generate build/icon.png — the Beacon app icon (1024x1024, pure stdlib, no deps).

The Codex tile: a squircle in a Skin Codex plate's paper, the seed of life and a graduated rete
ring in brass, and the beacon itself burning at the center in the plate's accent. Flagship is NOX
(the reference dark plate). electron-builder converts the PNG to .icns for the mac target.

Re-run after a design change:      python3 scripts/make-icon.py
Render another plate's colorway:   python3 scripts/make-icon.py vmbra   (→ build/icon-vmbra.png)
Plate colors mirror src/renderer/src/theme/tokens.css — keep them in sync. Nine plates as of
2026-09-03; NIGREDO is the blackout and a strong candidate for a second shipped icon.
"""
from __future__ import annotations

import math
import os
import struct
import sys
import zlib

W = H = 1024
MARGIN = 84
RADIUS = 205  # rounded-square corner radius
X0, Y0, X1, Y1 = MARGIN, MARGIN, W - MARGIN, H - MARGIN
HW, HH = (X1 - X0) / 2, (Y1 - Y0) / 2
RCX, RCY = (X0 + X1) / 2, (Y0 + Y1) / 2
CX, CY = W / 2, H / 2 - 16  # beacon sits a breath above true center, like the tile

# plate → (paper, geo/brass strokes, geo-strong/hairline, accent). From theme/tokens.css.
PLATES: dict[str, tuple[tuple[int, int, int], ...]] = {
    "nox": ((15, 18, 25), (138, 122, 78), (201, 182, 130), (184, 71, 58)),
    "lvx": ((231, 220, 196), (107, 91, 69), (46, 36, 24), (184, 71, 58)),
    "avrvm": ((23, 17, 6), (160, 132, 50), (220, 188, 85), (208, 154, 44)),
    "vmbra": ((12, 10, 20), (111, 101, 144), (168, 158, 204), (212, 160, 84)),
    "aervgo": ((11, 19, 16), (86, 128, 106), (127, 179, 151), (196, 122, 69)),
    "caervla": ((13, 27, 46), (74, 115, 150), (127, 168, 201), (217, 119, 66)),
    # Key is historical: this row is GLAVCVM (The Herbarium) — RVBEDO was retuned in place
    # 2026-09-03. Values mirror the [data-theme='rvbedo'] block in tokens.css.
    "rvbedo": ((232, 233, 230), (123, 139, 132), (60, 75, 69), (74, 122, 104)),
    "glavcvm": ((232, 233, 230), (123, 139, 132), (60, 75, 69), (74, 122, 104)),  # alias: render by label too
    "nigredo": ((5, 5, 6), (92, 92, 100), (156, 156, 164), (168, 64, 43)),
    "aether": ((225, 230, 230), (116, 136, 155), (56, 80, 95), (56, 101, 138)),
}

# geometry (tile construction scaled to 1024) — sized to READ AT DOCK SIZE: the beacon core and
# dial ring dominate the silhouette at 64 px; the seed of life is a whisper that only surfaces
# at 256 px+. (v1 drew everything in hairlines and the dock showed a dark square with a gold haze.)
RING_R = 408.0
TICK_IN, TICK_OUT = 388.0, 430.0
SEED_R = 185.0
CORE_R = 148.0
HALO1_R, HALO2_R = 232.0, 318.0
GLOW_R = 470.0
CORE_HOT = (255, 240, 225)  # inner-core lighten — the lamp is lit, not painted


def rr_sdf(px: float, py: float) -> float:
    """Signed distance to the rounded rectangle (negative inside)."""
    qx = abs(px - RCX) - (HW - RADIUS)
    qy = abs(py - RCY) - (HH - RADIUS)
    outside = math.hypot(max(qx, 0.0), max(qy, 0.0))
    inside = min(max(qx, qy), 0.0)
    return outside + inside - RADIUS


def clamp01(v: float) -> float:
    return 0.0 if v < 0.0 else 1.0 if v > 1.0 else v


def stroke_cov(dist_from_path: float, half_w: float) -> float:
    """Antialiased coverage for a stroke centred on a path."""
    return clamp01(half_w + 0.5 - abs(dist_from_path))


def build(plate: str) -> bytes:
    paper, geo, geo_s, accent = PLATES[plate]
    light = (0.299 * paper[0] + 0.587 * paper[1] + 0.114 * paper[2]) > 128
    glow_a = 0.20 if light else 0.38
    # vertical paper gradient: a breath of geo-strong sheen at top, a shade deeper at bottom
    top = tuple(paper[i] + (geo_s[i] - paper[i]) * 0.08 for i in range(3))
    bot = tuple(paper[i] * (0.95 if light else 0.88) for i in range(3))
    # the six outer seed-of-life centres
    seed_cs = [(CX + SEED_R * math.cos(math.radians(k * 60 - 90)), CY + SEED_R * math.sin(math.radians(k * 60 - 90))) for k in range(6)]

    raw = bytearray()
    for y in range(H):
        raw.append(0)  # PNG filter byte (None) per scanline
        ty = y / (H - 1)
        base = [top[i] + (bot[i] - top[i]) * ty for i in range(3)]
        for x in range(W):
            sdf = rr_sdf(x + 0.5, y + 0.5)
            mask = clamp01(0.5 - sdf / 1.5)
            if mask <= 0:
                raw += b"\x00\x00\x00\x00"
                continue
            px, py = x + 0.5, y + 0.5
            r, g, b = base

            def over(color: tuple[int, int, int], a: float) -> None:
                nonlocal r, g, b
                r += (color[0] - r) * a
                g += (color[1] - g) * a
                b += (color[2] - b) * a

            d = math.hypot(px - CX, py - CY)
            # accent glow behind the beacon
            gl = max(0.0, 1.0 - d / GLOW_R)
            if gl > 0:
                over(accent, gl * gl * glow_a)
            # inner hairline tracing the squircle
            over(geo_s, stroke_cov(sdf + 12.0, 1.6) * 0.25)
            if d < TICK_OUT + 8:
                # seed of life — a whisper of texture (visible at 256 px+, gone at dock size)
                over(geo, stroke_cov(d - SEED_R, 2.5) * 0.22)
                for cx2, cy2 in seed_cs:
                    over(geo, stroke_cov(math.hypot(px - cx2, py - cy2) - SEED_R, 2.5) * 0.14)
                # rete dial ring + 12 bold graduation ticks — the instrument silhouette
                over(geo, stroke_cov(d - RING_R, 4.5) * 0.70)
                if TICK_IN - 1 < d < TICK_OUT + 1 and d > 1:
                    ang = math.degrees(math.atan2(py - CY, px - CX)) % 30.0
                    da = min(ang, 30.0 - ang)
                    arc = math.radians(da) * d  # arc-length distance to the nearest tick
                    rad_cov = clamp01(min(d - TICK_IN, TICK_OUT - d) + 0.5)
                    over(geo, stroke_cov(arc, 4.5) * rad_cov * 0.65)
                # the beacon: two halos, then the burning core with a lit inner heart
                over(accent, stroke_cov(d - HALO2_R, 5.5) * 0.25)
                over(accent, stroke_cov(d - HALO1_R, 8.0) * 0.60)
                over(accent, clamp01(CORE_R + 0.5 - d))
                if d < CORE_R:
                    over(CORE_HOT, ((1.0 - d / CORE_R) ** 1.6) * 0.35)
            raw += bytes((int(r + 0.5), int(g + 0.5), int(b + 0.5), int(255 * mask + 0.5)))
    return bytes(raw)


def chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def main() -> None:
    plate = sys.argv[1] if len(sys.argv) > 1 else "nox"
    if plate not in PLATES:
        print(f"unknown plate '{plate}' — one of: {', '.join(PLATES)}")
        sys.exit(1)
    raw = build(plate)
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0))  # 8-bit RGBA
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    os.makedirs("build", exist_ok=True)
    out = "build/icon.png" if plate == "nox" else f"build/icon-{plate}.png"
    with open(out, "wb") as f:
        f.write(png)
    print(f"wrote {out} ({len(png)} bytes, {W}x{H}, plate={plate})")


if __name__ == "__main__":
    main()
