#!/usr/bin/env python3
"""Draw the app icons from the pi mark (three shapes on a grid).

The mark is the one in ../build/pi-logo.svg, whose paths are unions of
axis-aligned rectangles, so plain Python can rasterize it: no image library
needed. Run from mobile/: `python3 scripts/make-icons.py`.
"""
import struct
import zlib
from pathlib import Path

SIZE = 1024
# (color, rectangles) in the SVG's 800-unit space.
SHAPES = [
    ((0xF0, 0x90, 0x82), [(165.29, 165.29, 517.36, 282.65), (400, 282.65, 517.36, 400)]),
    ((0x4D, 0x9A, 0xBF), [(165.29, 282.65, 282.65, 634.72), (282.65, 400, 400, 517.36)]),
    ((0xF1, 0xBE, 0x58), [(517.36, 400, 634.72, 634.72)]),
]
GRAPHITE = (0x14, 0x15, 0x17)


def render(scale, background, mono=None):
    """`scale` is the mark's size relative to the full-bleed SVG."""
    pixels = bytearray((background + (255,) if background else (0, 0, 0, 0)) * SIZE * SIZE)
    factor = SIZE / 800 * scale
    offset = (SIZE - 800 * factor) / 2
    for color, rects in SHAPES:
        rgba = bytes((mono or color) + (255,))
        for x0, y0, x1, y1 in rects:
            left, right = round(offset + x0 * factor), round(offset + x1 * factor)
            for y in range(round(offset + y0 * factor), round(offset + y1 * factor)):
                start = (y * SIZE + left) * 4
                pixels[start:start + (right - left) * 4] = rgba * (right - left)
    return bytes(pixels)


def write_png(path, pixels):
    def chunk(tag, data):
        body = tag + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body))

    rows = b''.join(b'\x00' + pixels[y * SIZE * 4:(y + 1) * SIZE * 4] for y in range(SIZE))
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', SIZE, SIZE, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(rows, 9))
    png += chunk(b'IEND', b'')
    Path(path).write_bytes(png)


assets = Path(__file__).resolve().parent.parent / 'assets'
write_png(assets / 'icon.png', render(1.0, GRAPHITE))
# Adaptive icons are masked to a circle or squircle: keep the mark in the safe zone.
write_png(assets / 'android-icon-foreground.png', render(0.72, None))
write_png(assets / 'android-icon-background.png', render(0.0, GRAPHITE))
write_png(assets / 'android-icon-monochrome.png', render(0.72, None, (255, 255, 255)))
write_png(assets / 'splash-icon.png', render(1.0, None))
