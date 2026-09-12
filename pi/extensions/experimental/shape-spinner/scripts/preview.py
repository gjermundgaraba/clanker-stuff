# /// script
# requires-python = ">=3.11"
# dependencies = ["fonttools==4.64.0", "pillow==12.2.0"]
# ///
"""Decode the built font into native-size proofs; NOT a terminal renderer."""
import argparse
import io
import json
import tempfile
from pathlib import Path

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw

SIZES = (12, 14, 16, 18, 20)
THEMES = {"dark": ((24, 26, 31), (224, 227, 234)),
          "light": ((245, 244, 240), (35, 37, 43))}


def main():
    assets = Path(__file__).resolve().parents[1] / "assets"
    meta = json.loads((assets / "shapes.json").read_text())
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path(tempfile.gettempdir()) / "shape-spinner-review")
    parser.add_argument("--color", choices=meta["inks"], default="cyan")
    args = parser.parse_args()
    font = TTFont(assets / "ShapeSpinner.ttf")
    cmap = font.getBestCmap()
    strike = font["sbix"].strikes[64]
    args.out.mkdir(parents=True, exist_ok=True)

    def tile(codepoint, size, background):
        bitmap = strike.glyphs[cmap[codepoint]]
        sprite = Image.open(io.BytesIO(bitmap.imageData)).convert("RGBA")
        sprite = sprite.resize((size, size), Image.Resampling.LANCZOS)
        result = Image.new("RGBA", (2 * round(.6 * size), size), (*background, 255))
        result.alpha_composite(sprite, ((result.width - size) // 2, 0))
        return result.convert("RGB")

    # All colors on the actual two backgrounds, decoded from the shipped font.
    for theme, (background, foreground) in THEMES.items():
        sheet = Image.new("RGB", (950, 950), background)
        draw = ImageDraw.Draw(sheet)
        draw.text((10, 8), f"Amp bright palette / {theme} - 16px and 4x embedded pixels", fill=foreground)
        for column, shape in enumerate(meta["animations"]):
            draw.text((110 + column * 210, 30), shape + " (rest / working)", fill=foreground)
        for row, color in enumerate(meta["inks"]):
            y = 55 + row * 98
            draw.text((10, y), color, fill=foreground)
            for column, colors in enumerate(meta["animations"].values()):
                animation = colors[color][theme]
                for sample, codepoint in enumerate([animation["still"], animation["frames"][50]]):
                    x = 110 + column * 210 + sample * 100
                    image = tile(codepoint, 16, background)
                    sheet.paste(image, (x, y))
                    sheet.paste(image.resize((image.width * 4, 64), Image.Resampling.NEAREST), (x, y + 20))
        sheet.save(args.out / f"palette-{theme}.png")

    animations = {shape: colors[args.color] for shape, colors in meta["animations"].items()}
    animations["rubik"] = {theme: meta["rubik"] for theme in THEMES}
    for shape, backgrounds in animations.items():
        for theme, animation in backgrounds.items():
            background, foreground = THEMES[theme]
            count = len(animation["frames"])
            # Include the seam and the solved hold even for the shorter puzzle loop.
            samples = [round((count - 1) * i / 8) for i in range(9)]
            sheet = Image.new("RGB", (1100, 660), background)
            draw = ImageDraw.Draw(sheet)
            draw.text((10, 10), f"{shape} / {args.color} / {theme} - embedded bitmaps, 1x and 4x; verify in Ghostty", fill=foreground)
            for row, size in enumerate(SIZES):
                y = 40 + row * 120
                draw.text((8, y), f"{size}px", fill=foreground)
                codepoints = [animation["still"], *[animation["frames"][i] for i in samples]]
                for col, codepoint in enumerate(codepoints):
                    x = 65 + col * 103
                    draw.text((x, y), "rest" if col == 0 else str(samples[col - 1]), fill=foreground)
                    image = tile(codepoint, size, background)
                    sheet.paste(image, (x, y + 20))
                    sheet.paste(image.resize((image.width * 4, size * 4), Image.Resampling.NEAREST), (x, y + 25 + size))
            sheet.save(args.out / f"{shape}-{args.color}-{theme}-sizes.png")
            frames = [tile(codepoint, 20, background) for codepoint in animation["frames"]]
            durations = [round((i + 1) * 100 / meta["fps"]) * 10 - round(i * 100 / meta["fps"]) * 10
                         for i in range(len(frames))]
            for zoom in (1, 4):
                images = [im.resize((im.width * zoom, im.height * zoom), Image.Resampling.NEAREST) for im in frames]
                images[0].save(args.out / f"{shape}-{args.color}-{theme}-{zoom}x.gif", save_all=True,
                               append_images=images[1:], duration=durations, loop=0, disposal=2)
    print(f"Font proofs: {args.out.resolve()} (not Ghostty-native rendering)")


if __name__ == "__main__":
    main()
