#!/usr/bin/env python3
"""Generate crisp tray/app icons (pixel-perfect at 16/32, high-res app icon at 256)."""
from __future__ import annotations

import os
from pathlib import Path

from PIL import Image, ImageDraw

INDIGO = (99, 102, 241, 255)
WHITE = (255, 255, 255, 255)
TRANSPARENT = (0, 0, 0, 0)

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "resources"


def fill_rect(img: Image.Image, x0: int, y0: int, x1: int, y1: int, color: tuple[int, int, int, int]) -> None:
    px = img.load()
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            if 0 <= x < img.width and 0 <= y < img.height:
                px[x, y] = color


def create_tray_16() -> Image.Image:
    """16×16 pixel-perfect tray icon."""
    img = Image.new("RGBA", (16, 16), TRANSPARENT)
    fill_rect(img, 1, 1, 14, 14, INDIGO)
    # Bold W tuned for 16px
    fill_rect(img, 3, 4, 4, 11, WHITE)
    fill_rect(img, 11, 4, 12, 11, WHITE)
    fill_rect(img, 5, 9, 6, 11, WHITE)
    fill_rect(img, 6, 8, 7, 9, WHITE)
    fill_rect(img, 9, 9, 10, 11, WHITE)
    fill_rect(img, 8, 8, 9, 9, WHITE)
    fill_rect(img, 7, 10, 8, 11, WHITE)
    return img


def create_tray_32() -> Image.Image:
    """32×32: 2× nearest-neighbor upscale of 16px art (no blur)."""
    return create_tray_16().resize((32, 32), Image.NEAREST)


def create_app_256() -> Image.Image:
    img = Image.new("RGBA", (256, 256), TRANSPARENT)
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle([20, 20, 235, 235], radius=52, fill=INDIGO)
    w = create_tray_16().resize((140, 140), Image.NEAREST)
    img.paste(w, (58, 58), w)
    return img


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    tray16 = create_tray_16()
    tray32 = create_tray_32()
    app256 = create_app_256()

    tray16.save(OUT / "tray-16.png")
    tray32.save(OUT / "tray-32.png")
    tray32.save(OUT / "tray.png")
    app256.save(OUT / "icon.png")

    tray16.save(
        OUT / "tray.ico",
        format="ICO",
        sizes=[(16, 16), (32, 32)],
        append_images=[tray32],
    )
    app256.save(
        OUT / "icon.ico",
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
        append_images=[
            tray16,
            tray32,
            tray32.resize((48, 48), Image.NEAREST),
            tray32.resize((64, 64), Image.NEAREST),
            app256.resize((128, 128), Image.LANCZOS),
        ],
    )
    print("Generated:", ", ".join(p.name for p in sorted(OUT.iterdir())))


if __name__ == "__main__":
    main()
