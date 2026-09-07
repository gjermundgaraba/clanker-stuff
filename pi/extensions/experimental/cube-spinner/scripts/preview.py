#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["fonttools==4.64.0", "freetype-py==2.5.1", "pillow==12.2.0"]
# ///
"""Preview actual sbix pixels and fallback outlines, not Ghostty's renderer."""

import argparse
import io
import json
import tempfile
from pathlib import Path

import freetype
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw

SIZES = (12, 14, 16, 18, 20)
THEMES = {
    "dark": ((24, 26, 31), (224, 227, 234)),
    "light": ((245, 244, 240), (35, 37, 43)),
}
ZOOM = 4


def bitmap_image(bitmap, foreground):
    """Convert the actual FreeType grayscale fallback raster into RGBA."""
    width, height = bitmap.width, bitmap.rows
    if not width or not height:
        return Image.new("RGBA", (1, 1))
    assert bitmap.pixel_mode == freetype.FT_PIXEL_MODE_GRAY
    mask = Image.frombytes(
        "L",
        (width, height),
        bytes(bitmap.buffer),
        "raw",
        "L",
        abs(bitmap.pitch),
        1 if bitmap.pitch >= 0 else -1,
    )
    image = Image.new("RGBA", (width, height), (*foreground, 255))
    image.putalpha(mask)
    return image


def render(face, strikes, pair, px, color, background, foreground, clipped):
    cell = round(600 * px / 1000)
    canvas = Image.new("RGBA", (2 * cell, px), (*background, 255))
    codepoint, space = pair
    assert space == 32
    if color:
        ppem = min((size for size in strikes if size >= px), default=max(strikes))
        sprite = strikes[ppem][codepoint]
        # Preserve the entire fixed square canvas; never stretch or crop to moving ink.
        side = min(canvas.size)
        sprite = sprite.resize(
            (side, side),
            Image.Resampling.LANCZOS,
        )
        x, y = (canvas.width - sprite.width) // 2, (canvas.height - sprite.height) // 2
    else:
        face.set_pixel_sizes(0, px)
        face.load_char(codepoint, freetype.FT_LOAD_RENDER | freetype.FT_LOAD_NO_BITMAP)
        glyph = face.glyph
        assert round(glyph.advance.x / 64) == cell
        sprite = bitmap_image(glyph.bitmap, foreground)
        x, y = glyph.bitmap_left, round(800 * px / 1000) - glyph.bitmap_top
    bounds = sprite.getbbox()
    if bounds and (
        x + bounds[0] < 0
        or y + bounds[1] < 0
        or x + bounds[2] > canvas.width
        or y + bounds[3] > canvas.height
    ):
        clipped.add((px, codepoint, "color" if color else "mono"))
    canvas.alpha_composite(sprite, (x, y))
    return canvas.convert("RGB")


def contact_sheet(rows, indexes, background, foreground, title):
    """Each tile shows display-size pixels above an unfiltered 4x enlargement."""
    tile_width = 2 * round(600 * max(SIZES) / 1000) * ZOOM + 16
    row_heights = [34 + row[0].height * (ZOOM + 1) + 12 for _, row in rows]
    sheet = Image.new(
        "RGB", (100 + len(indexes) * tile_width, 30 + sum(row_heights)), background
    )
    draw = ImageDraw.Draw(sheet)
    draw.text((8, 8), title, fill=foreground)
    y = 30
    for (px, row), height in zip(rows, row_heights):
        draw.text((8, y + 8), f"{px}px\n1x / 4x", fill=foreground)
        for column, index in enumerate(indexes):
            x = 100 + column * tile_width
            sprite = row[index]
            draw.text((x, y + 4), str(index), fill=foreground)
            sheet.paste(sprite, (x, y + 22))
            sheet.paste(
                sprite.resize(
                    (sprite.width * ZOOM, sprite.height * ZOOM),
                    Image.Resampling.NEAREST,
                ),
                (x, y + 28 + px),
            )
        y += height
    return sheet


def all_frames_sheet(frames, background, foreground):
    columns = 10
    tile_width, tile_height = (
        frames[0].width * ZOOM + 16,
        frames[0].height * (ZOOM + 1) + 36,
    )
    sheet = Image.new(
        "RGB",
        (columns * tile_width, ((len(frames) + columns - 1) // columns) * tile_height),
        background,
    )
    draw = ImageDraw.Draw(sheet)
    for index, frame in enumerate(frames):
        x, y = index % columns * tile_width + 8, index // columns * tile_height + 4
        draw.text((x, y), str(index), fill=foreground)
        sheet.paste(frame, (x, y + 18))
        sheet.paste(
            frame.resize(
                (frame.width * ZOOM, frame.height * ZOOM), Image.Resampling.NEAREST
            ),
            (x, y + 24 + frame.height),
        )
    return sheet


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out", type=Path, default=Path(tempfile.gettempdir()) / "cube-spinner-review"
    )
    args = parser.parse_args()
    assets = Path(__file__).resolve().parents[1] / "assets"
    metadata = json.loads((assets / "cube.json").read_text())
    frames, fps = metadata["frames"], metadata["fps"]
    assert 0 <= metadata["still"] < len(frames)
    assert frames[0] != frames[metadata["still"]]
    strikes = {}
    with TTFont(assets / "CubeSpinner.ttf") as font:
        assert font["head"].unitsPerEm == 1000
        assert (font["hhea"].ascent, font["hhea"].descent) == (800, -200)
        assert "sbix" in font and "COLR" not in font and "CPAL" not in font
        cmap = font.getBestCmap()
        for pair in frames:
            assert len(pair) == 2 and pair[1] == 32
            for codepoint in pair:
                assert font["hmtx"][cmap[codepoint]][0] == 600
            glyph = font["glyf"][cmap[pair[0]]]
            assert (glyph.xMin, glyph.yMin, glyph.xMax, glyph.yMax) == (
                0,
                -200,
                1000,
                800,
            )
        for ppem, strike in sorted(font["sbix"].strikes.items()):
            strikes[ppem] = {}
            edge_peak, edge_glyphs = 0, 0
            for codepoint in sorted({pair[0] for pair in frames}):
                glyph = strike.glyphs[cmap[codepoint]]
                assert glyph.graphicType == "png "
                assert glyph.originOffsetX == 0
                assert glyph.originOffsetY == 0
                with Image.open(io.BytesIO(glyph.imageData)) as image:
                    assert image.mode == "RGBA"
                    assert image.size == (ppem, ppem)
                    alpha = image.getchannel("A")
                    low, high = alpha.getextrema()
                    assert low == 0 and high > 0, (
                        "Expected visible ink and transparency"
                    )
                    width, height = image.size
                    peak = max(
                        alpha.crop(box).getextrema()[1]
                        for box in (
                            (0, 0, width, 1),
                            (0, height - 1, width, height),
                            (0, 0, 1, height),
                            (width - 1, 0, width, height),
                        )
                    )
                    edge_peak = max(edge_peak, peak)
                    edge_glyphs += peak > 0
                    strikes[ppem][codepoint] = image.copy()
            print(
                f"Validated {len(strikes[ppem])} transparent fixed-canvas PNGs at {ppem}ppem"
            )
            print(
                f"  Source PNG outer-edge alpha: max {edge_peak}/255; {edge_glyphs} glyphs have fringe."
            )
        # Bundled FreeType treats sbix as bitmap-only and cannot decode its PNGs.
        # Remove the table in memory solely to expose the unchanged glyf fallback.
        del font["sbix"]
        outlines = io.BytesIO()
        font.save(outlines)
    face = freetype.Face.from_bytes(outlines.getvalue())
    args.out.mkdir(parents=True, exist_ok=True)
    indexes = sorted({round(i * (len(frames) - 1) / 11) for i in range(12)})
    clipped = set()
    # GIF timing is in 10ms ticks; distribute rounding without changing cycle duration.
    durations = [
        round((i + 1) * 100 / fps) * 10 - round(i * 100 / fps) * 10
        for i in range(len(frames))
    ]
    for theme, (background, foreground) in THEMES.items():
        for color in (True, False):
            mode = "color" if color else "mono"
            rows = [
                (
                    px,
                    [
                        render(
                            face,
                            strikes,
                            pair,
                            px,
                            color,
                            background,
                            foreground,
                            clipped,
                        )
                        for pair in frames
                    ],
                )
                for px in SIZES
            ]
            method = (
                "embedded sbix strike, scaled preview; verify actual terminal"
                if color
                else "FreeType outline fallback"
            )
            title = f"{metadata['family']} - {theme}, {method}"
            contact_sheet(rows, indexes, background, foreground, title).save(
                args.out / f"{mode}-{theme}-sizes.png"
            )
            native = rows[-1][1]
            native[metadata["still"]].save(args.out / f"{mode}-{theme}-still.png")
            all_frames_sheet(native, background, foreground).save(
                args.out / f"{mode}-{theme}-frames.png"
            )
            if color:
                for scale in (1, ZOOM):
                    images = [
                        frame.resize(
                            (frame.width * scale, frame.height * scale),
                            Image.Resampling.NEAREST,
                        )
                        for frame in native
                    ]
                    images[0].save(
                        args.out / f"{theme}-{scale}x.gif",
                        save_all=True,
                        append_images=images[1:],
                        duration=durations,
                        loop=0,
                        disposal=2,
                    )
    print(f"Rendered {len(frames)} frames at {fps}fps to {args.out.resolve()}")
    print(
        f"Color decodes embedded sbix PNGs; FreeType {'.'.join(map(str, freetype.version()))} renders unchanged glyf outlines with sbix removed in memory."
    )
    print(
        "Color previews scale actual bitmap strikes into two cells; this is an approximation, NOT Ghostty-native rendering."
    )
    if clipped:
        print(
            f"WARNING: ink outside the two-cell viewport in {len(clipped)} glyph/size/mode combinations:"
        )
        for px, codepoint, mode in sorted(clipped):
            print(f"  {mode} {px}px U+{codepoint:X}")
    else:
        print("No glyph ink outside the two-cell viewport at any tested size.")


if __name__ == "__main__":
    main()
