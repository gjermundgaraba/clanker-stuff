# /// script
# requires-python = ">=3.11"
# dependencies = ["fonttools==4.64.0", "pillow==12.2.0"]
# ///
"""Build checked-in sbix assets; uv run scripts/build.py [--check].

Chrome (CHROME executable override) rasterizes the reconstructed model on an
isolated, temporary, offline page. No Amp resources or runtime processes needed.
"""
import argparse
import base64
import hashlib
import io
import json
import subprocess
import tempfile
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont, newTable
from fontTools.ttLib.tables.sbixGlyph import Glyph
from fontTools.ttLib.tables.sbixStrike import Strike
from PIL import Image

import rubik

HERE = Path(__file__).resolve().parent
ASSETS = HERE.parent / "assets"
BASE = 0x100000
UPM, ADVANCE, ASCENT, DESCENT = 1000, 600, 800, -200


def bounds_glyph():
    # CoreText places sbix pixels relative to these bounds. The zero-area
    # contours reserve a fixed square without adding monochrome artwork.
    pen = TTGlyphPen(None)
    for x, y, dx in ((0, DESCENT, 1), (UPM, ASCENT, -1)):
        pen.moveTo((x, y))
        pen.lineTo((x + dx, y))
        pen.closePath()
    return pen.glyph()


def optimize_png(bitmap):
    # Lossless recompression: no palette quantization, recoloring or alpha changes.
    original = Image.open(io.BytesIO(bitmap))
    output = io.BytesIO()
    original.save(output, format="PNG", optimize=True)
    optimized = output.getvalue()
    return optimized if len(optimized) < len(bitmap) else bitmap


def build(rendered):
    license_text = (HERE.parent / "LICENSE").read_text()
    glyphs = {".notdef": TTGlyphPen(None).glyph(), "space": TTGlyphPen(None).glyph()}
    cmap, seen, animations = {32: "space"}, {}, {}
    sbix = newTable("sbix")
    sbix.strikes = {size: Strike(ppem=size, resolution=72) for size in rendered["strikes"]}
    def add_frame(bitmaps):
        if bitmaps not in seen:
            cp = BASE + len(seen)
            assert cp <= 0x10FFFD, "Font bank exceeds supplementary private use"
            name = f"shape.{len(seen):04d}"
            glyphs[name] = bounds_glyph()
            cmap[cp] = name
            for size, bitmap in zip(rendered["strikes"], bitmaps):
                sbix.strikes[size].glyphs[name] = Glyph(
                    glyphName=name, graphicType="png ", imageData=bitmap,
                    originOffsetX=0, originOffsetY=0,
                )
            seen[bitmaps] = cp
        return seen[bitmaps]

    for shape, colors in rendered["animations"].items():
        animations[shape] = {}
        for color, inks in colors.items():
            animations[shape][color] = {}
            for background, sprites in inks.items():
                frames = []
                assert len(sprites) == rendered["fps"] * 8 + 1
                for sprite in sprites:
                    bitmaps = tuple(optimize_png(base64.b64decode(bitmap)) for bitmap in sprite)
                    frames.append(add_frame(bitmaps))
                animations[shape][color][background] = {"seconds": 8, "frames": frames[:-1], "still": frames[-1]}
                assert frames[0] != frames[-1], "Rest is not the first working frame"

    # Solid sticker artwork shares the same font, metrics and playback API.
    assert rubik.FPS == rendered["fps"]
    scenes = rubik.scenes()
    rubik.check_scene(scenes)
    authored, raster_cache = [], {}
    for scene in scenes:
        key = tuple(scene)
        if key not in raster_cache:
            raster_cache[key] = tuple(rubik.raster(scene, size) for size in rendered["strikes"])
        authored.append(add_frame(raster_cache[key]))
    frames = authored[rubik.PLAYBACK_START:] + authored[:rubik.PLAYBACK_START]
    assert len(frames) == rubik.FRAME_COUNT
    assert frames[rubik.STILL] == authored[0] != frames[0]
    solved = {"seconds": rubik.FRAME_COUNT / rubik.FPS, "frames": frames, "still": authored[0]}

    fb = FontBuilder(UPM, isTTF=True)
    fb.setupGlyphOrder(list(glyphs))
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics({name: (ADVANCE, 0) for name in glyphs})
    fb.setupHorizontalHeader(ascent=ASCENT, descent=DESCENT, lineGap=0)
    fb.setupOS2(fsType=0, sTypoAscender=ASCENT, sTypoDescender=DESCENT,
                sTypoLineGap=0, usWinAscent=ASCENT, usWinDescent=-DESCENT)
    fb.setupPost(isFixedPitch=1)
    fb.font["sbix"] = sbix
    fb.font.recalcTimestamp = False
    fb.font["head"].created = fb.font["head"].modified = 3660681600
    output = io.BytesIO()
    fb.font.save(output)
    # Hash the assembled font before adding its derived names. Source comments,
    # browser provenance and animation timing do not change installed glyphs.
    digest = hashlib.sha256(output.getvalue()).hexdigest()[:10]
    family = f"Shape Spinner {digest}"
    # Reuse compiled tables when adding names instead of recompiling sbix.
    fb.font = TTFont(output, lazy=True, recalcTimestamp=False)
    fb.setupNameTable({
        "copyright": "Copyright (c) 2026 Gjermund Garaba",
        "familyName": family, "styleName": "Regular",
        "fullName": family + " Regular", "psName": "ShapeSpinner-" + digest,
        "uniqueFontIdentifier": "ShapeSpinner;" + digest,
        "version": "Version 1.000", "licenseDescription": license_text,
    })
    output = io.BytesIO()
    fb.font.save(output)
    metadata = {key: rendered[key] for key in ("fps", "seed", "inks", "viewbox", "browser")}
    metadata = {"family": family, **metadata, "animations": animations, "rubik": solved}
    return output.getvalue(), (json.dumps(metadata, indent=2) + "\n").encode()


def validate(font_bytes, metadata):
    font = TTFont(io.BytesIO(font_bytes))
    meta = json.loads(metadata)
    loops = [animation for colors in meta["animations"].values() for inks in colors.values()
             for animation in inks.values()] + [meta["rubik"]]
    codepoints = {cp for animation in loops for cp in [*animation["frames"], animation["still"]]}
    rubik_codepoints = set(meta["rubik"]["frames"])
    cmap = font.getBestCmap()
    assert set(cmap) == codepoints | {32}
    assert font["OS/2"].fsType == 0
    assert all(font["hmtx"][name] == (ADVANCE, 0) for name in cmap.values())
    assert set(font["sbix"].strikes) == {32, 64}
    for size, strike in font["sbix"].strikes.items():
        for cp in codepoints:
            name = cmap[cp]
            bitmap = strike.glyphs[name]
            assert bitmap.graphicType == "png "
            assert (bitmap.originOffsetX, bitmap.originOffsetY) == (0, 0)
            im = Image.open(io.BytesIO(bitmap.imageData))
            assert im.mode == "RGBA" and im.size == (size, size)
            bounds = im.getbbox()
            assert bounds and im.getpixel((0, 0))[3] == 0
            if cp not in rubik_codepoints:
                assert 0 < bounds[0] < bounds[2] < size
                assert 0 < bounds[1] < bounds[3] < size, (size, cp, bounds)
            # Rubik fills 94% of the em: Lanczos fringe can touch the bitmap edge.
            # check_scene proves a 29-unit geometric inset; CoreText tests actual
            # paint against fixed glyph bounds. Do not shrink each frame to ink.
            glyph = font["glyf"][name]
            assert (glyph.xMin, glyph.yMin, glyph.xMax, glyph.yMax) == (0, DESCENT, UPM, ASCENT)
    return meta, len(codepoints)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="shape-spinner-build-") as tmp:
        rendered_path = Path(tmp) / "rendered.json"
        subprocess.run(["node", str(HERE / "render.mjs"), str(rendered_path)], check=True)
        rendered = json.loads(rendered_path.read_text())
    font, metadata = build(rendered)
    if args.check:
        assert (font, metadata) == build(rendered), "Font assembly is not deterministic"
    meta, count = validate(font, metadata)
    metadata = subprocess.run(
        ["vp", "fmt", "--stdin-filepath", str(ASSETS / "shapes.json")],
        input=metadata, stdout=subprocess.PIPE, check=True, cwd=HERE.parent,
    ).stdout
    for name, content in (("ShapeSpinner.ttf", font), ("shapes.json", metadata)):
        destination = ASSETS / name
        if args.check:
            if not destination.exists() or destination.read_bytes() != content:
                raise SystemExit(f"{destination} is stale; rebuild with the recorded Chrome version")
        else:
            ASSETS.mkdir(exist_ok=True)
            destination.write_bytes(content)
    print(f"{'Checked' if args.check else 'Built'} {meta['family']}: {count} glyphs, {len(font):,} bytes; {meta['browser']}")


if __name__ == "__main__":
    main()
