# /// script
# requires-python = ">=3.11"
# dependencies = ["fonttools==4.64.0", "pillow==12.2.0"]
# ///
"""Build the solid, two-cell cube flipbook: uv run scripts/build.py [--check].

Twenty-six cubies retain their 54 sticker identities through a short scramble
and its exact inverse. Opaque body/sticker polygons, a stationary camera and
one shared canvas make turns readable without runtime rendering or solving.
All geometry, rasterization and font tooling is build-time only.
"""

import argparse
import hashlib
import io
import json
import math
import re
from itertools import pairwise, product
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont, newTable
from fontTools.ttLib.tables.sbixGlyph import Glyph
from fontTools.ttLib.tables.sbixStrike import Strike
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
ASSETS = HERE.parent / "assets"
FPS = 60
UPM = 1000
ADVANCE = 600
# Ghostty fits the fixed color-glyph bounds into the two reserved cells. A
# square canvas uses their nearly square physical viewport without distortion.
WIDTH = 1000
ASCENT = 800
DESCENT = -200
STRIKES = (64, 128)
SUPERSAMPLE = 4
BASE = 0x10E900
YAW = 0.58
PITCH = -0.43
# Right, left, top, bottom, back, front. Flat, saturated fills stay legible
# at terminal sizes; narrow dark gutters separate each face's nine stickers.
COLORS = (
    (0.94, 0.22, 0.20),
    (1.00, 0.49, 0.08),
    (0.94, 0.96, 1.00),
    (1.00, 0.82, 0.08),
    (0.12, 0.75, 0.36),
    (0.10, 0.43, 0.98),
)
NORMALS = ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1))
SCRAMBLE = ((0, 1, 1), (1, 1, -1), (2, -1, 1), (0, 1, -1), (1, 1, 1))
SOLVE = tuple(
    (axis, layer, -direction) for axis, layer, direction in reversed(SCRAMBLE)
)
# Scramble turns take 0.2 seconds; solving keeps its readable 0.5-second turns.
# The two solved holds join into 0.7 seconds before the next quick scramble.
TIMELINE = (
    ((None, 24),)
    + tuple((move, 12) for move in SCRAMBLE)
    + ((None, 12),)
    + tuple((move, 30) for move in SOLVE)
    + ((None, 18),)
)
FRAME_COUNT = sum(length for _, length in TIMELINE)
# Authoring stays solved-first so geometry, glyph order and PNGs remain stable.
# Playback begins at the scrambled hold, then solves before scrambling again.
PLAYBACK_START = sum(length for _, length in TIMELINE[: 1 + len(SCRAMBLE)])
SOLVED_START = sum(length for _, length in TIMELINE[:-1])
STILL = (SOLVED_START - PLAYBACK_START) % FRAME_COUNT


def rotate(point, axis, angle):
    x, y, z = point
    c, s = math.cos(angle), math.sin(angle)
    return (
        (x, y * c - z * s, y * s + z * c),
        (x * c + z * s, y, -x * s + z * c),
        (x * c - y * s, x * s + y * c, z),
    )[axis]


def quarter(point, axis, direction):
    return tuple(round(v) for v in rotate(point, axis, direction * math.pi / 2))


def ease(t):
    # Cosine acceleration over 16% at each end, constant velocity in between.
    ramp = 0.16
    velocity = 1 / (1 - ramp)
    if t < ramp:
        return velocity * (t / 2 - ramp * math.sin(math.pi * t / ramp) / (2 * math.pi))
    if t > 1 - ramp:
        return 1 - ease(1 - t)
    return velocity * (t - ramp / 2)


def initial_cubies():
    cubies = []
    for pos in product((-1, 0, 1), repeat=3):
        if pos == (0, 0, 0):
            continue
        # Only sticker normals carry identity; body turns just permute NORMALS.
        stickers = tuple(
            (normal, color)
            for color, normal in enumerate(NORMALS)
            if sum(a * b for a, b in zip(pos, normal)) == 1
        )
        cubies.append((pos, stickers))
    return cubies


def apply_move(cubies, move):
    axis, layer, direction = move
    return [
        (
            quarter(position, axis, direction),
            tuple(
                (quarter(normal, axis, direction), color) for normal, color in stickers
            ),
        )
        if position[axis] == layer
        else (position, stickers)
        for position, stickers in cubies
    ]


def pose(frame):
    cubies = initial_cubies()
    frame %= FRAME_COUNT
    for move, length in TIMELINE:
        if frame < length:
            return cubies, move, ease(frame / length) if move else 0
        if move:
            cubies = apply_move(cubies, move)
        frame -= length
    raise AssertionError("unreachable frame")


def camera(point):
    return rotate(rotate(point, 1, YAW), 0, PITCH)


def face(center, normal, half, plane):
    # Construct local plane before partial turns; all completed normals remain integral.
    axis = next(i for i, v in enumerate(normal) if v)
    aa, bb = (axis + 1) % 3, (axis + 2) % 3
    points = []
    for a, b in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        p = [center[i] + normal[i] * plane for i in range(3)]
        p[aa] += a * half
        p[bb] += b * half
        points.append(tuple(p))
    return points


def raw_scene(frame):
    cubies, move, t = pose(frame)
    out = []
    for pos, stickers in cubies:
        moving = move and pos[move[0]] == move[1]

        def transform(p, moving=moving):
            if moving:
                p = rotate(p, move[0], move[2] * t * math.pi / 2)
            return camera(p)

        for normal, color in [(n, None) for n in NORMALS] + list(stickers):
            normal_view = transform(normal)
            if normal_view[2] >= -1e-8:
                continue
            # Thin black gutters, no dot lattice, gloss, rounded stickers or wiremesh.
            vertices = [
                transform(p)
                for p in face(
                    pos,
                    normal,
                    0.495 if color is None else 0.459,
                    0.495 if color is None else 0.496,
                )
            ]
            if color is None:
                rgb = (0.055, 0.067, 0.085)
            else:
                light = max(0, min(1, normal_view[1] * 0.45 - normal_view[2] * 0.85))
                shade = 0.9 + 0.1 * light
                rgb = tuple(v * shade for v in COLORS[color])
            out.append((vertices, rgb, color))
    # Opaque faces are backface-culled above, then painted far to near. The
    # sticker plane sits just outside its cubie's body so gutters stay dark.
    out.sort(key=lambda item: -sum(p[2] for p in item[0]) / 4)
    return out


def scenes():
    # Normalize the UNION of every pose once, never individual frame bounds.
    # Mid-turn corners have room to swing without clipping or camera zooms.
    allscenes = [raw_scene(f) for f in range(FRAME_COUNT)]
    xs = [p[0] for sc in allscenes for vs, _, _ in sc for p in vs]
    ys = [p[1] for sc in allscenes for vs, _, _ in sc for p in vs]
    extent = max(max(xs) - min(xs), max(ys) - min(ys))
    scale = 940 / extent
    cx = (max(xs) + min(xs)) / 2
    cy = (max(ys) + min(ys)) / 2
    scenes = [
        [
            (
                tuple(
                    (round(500 + (x - cx) * scale, 6), round(300 + (y - cy) * scale, 6))
                    for x, y, z in vs
                ),
                tuple(round(v * 255) for v in rgb),
                color,
            )
            for vs, rgb, color in sc
        ]
        for sc in allscenes
    ]
    return scenes


def raster(scene, ppem):
    im = Image.new("RGBA", (ppem * SUPERSAMPLE, ppem * SUPERSAMPLE))
    draw = ImageDraw.Draw(im)
    for vs, rgb, _ in scene:
        draw.polygon(
            [
                (x * ppem * SUPERSAMPLE / UPM, (ASCENT - y) * ppem * SUPERSAMPLE / UPM)
                for x, y in vs
            ],
            fill=rgb + (255,),
        )
    im = im.resize((ppem, ppem), Image.Resampling.LANCZOS)
    output = io.BytesIO()
    im.save(output, format="PNG", compress_level=9)
    return output.getvalue()


def build_font():
    license_text = (HERE.parent / "LICENSE").read_text()
    digest = hashlib.sha256(
        Path(__file__).read_bytes() + license_text.encode()
    ).hexdigest()[:10]
    family = f"Cube Spinner {digest}"
    glyphs = {".notdef": TTGlyphPen(None).glyph(), "space": TTGlyphPen(None).glyph()}
    cmap, frames, seen, rendered = {0x20: "space"}, [], {}, {}
    sbix = newTable("sbix")
    sbix.strikes = {ppem: Strike(ppem=ppem, resolution=72) for ppem in STRIKES}
    for scene in scenes():
        # Exact bitmap deduplication preserves every interpolated frame while
        # sharing aligned holds and matching poses on the inverse solution.
        geometry_key = tuple(scene)
        if geometry_key not in rendered:
            rendered[geometry_key] = tuple(raster(scene, ppem) for ppem in STRIKES)
        bitmaps = rendered[geometry_key]
        if bitmaps in seen:
            frames.append(seen[bitmaps])
            continue
        index = len(seen)
        name = f"cube.{index:03d}"
        cp = BASE + index
        assert cp <= 0x10FFFD, "cube frames overflow supplementary private use"
        fallback = TTGlyphPen(None)
        for vertices, _, color in scene:
            if color is None:
                continue
            fallback.moveTo(tuple(round(v) for v in vertices[0]))
            for point in vertices[1:]:
                fallback.lineTo(tuple(round(v) for v in point))
            fallback.closePath()
        # Zero-area contours anchor a constant square without painting marks.
        # Ghostty centers/scales color glyphs by these CoreText bounds; varying
        # bounds would make each animation frame jump or change apparent size.
        for x, y, dx in ((0, DESCENT, 1), (WIDTH, ASCENT, -1)):
            fallback.moveTo((x, y))
            fallback.lineTo((x + dx, y))
            fallback.closePath()
        glyphs[name] = fallback.glyph()
        cmap[cp] = name
        # With contours, sbix offsets are relative to the glyph bounding box's
        # lower-left corner (OpenType sbix spec), not the baseline. Our bounds
        # already include DESCENT; adding it again clips the bitmap's bottom.
        for ppem, bitmap in zip(STRIKES, bitmaps):
            sbix.strikes[ppem].glyphs[name] = Glyph(
                glyphName=name,
                graphicType="png ",
                imageData=bitmap,
                originOffsetX=0,
                originOffsetY=0,
            )
        # A literal space reserves the second terminal column. Ghostty permits
        # a PUA symbol followed by a space to occupy both cells.
        pair = [cp, 0x20]
        seen[bitmaps] = pair
        frames.append(pair)

    fb = FontBuilder(UPM, isTTF=True)
    fb.setupGlyphOrder(list(glyphs))
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(glyphs)
    metrics = {}
    for name, glyph in glyphs.items():
        glyph.recalcBounds(None)
        if glyph.numberOfContours:
            assert (glyph.xMin, glyph.yMin, glyph.xMax, glyph.yMax) == (
                0,
                DESCENT,
                WIDTH,
                ASCENT,
            ), name
        metrics[name] = (ADVANCE, getattr(glyph, "xMin", 0))
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=ASCENT, descent=DESCENT, lineGap=0)
    fb.setupNameTable(
        {
            "copyright": "Copyright (c) 2026 Gjermund Garaba",
            "familyName": family,
            "styleName": "Regular",
            "fullName": family + " Regular",
            "psName": "CubeSpinner-" + digest,
            "uniqueFontIdentifier": "CubeSpinner;" + digest,
            "version": "Version 1.000",
            "licenseDescription": license_text,
        }
    )
    fb.setupOS2(
        fsType=0,  # Unrestricted embedding, consistent with the font's MIT license.
        sTypoAscender=ASCENT,
        sTypoDescender=DESCENT,
        sTypoLineGap=0,
        usWinAscent=ASCENT,
        usWinDescent=-DESCENT,
    )
    fb.setupPost(isFixedPitch=1)
    # Ghostty 1.3.1's CoreText backend recognizes sbix/SVG color glyphs, not
    # COLR. sbix also makes the antialiasing/shading explicit and reproducible.
    fb.font["sbix"] = sbix
    fb.font.recalcTimestamp = False
    fb.font["head"].created = fb.font["head"].modified = (
        3660681600  # 2020-01-01 UTC, OpenType epoch
    )
    output = io.BytesIO()
    fb.font.save(output)
    authored_frames = frames
    frames = authored_frames[PLAYBACK_START:] + authored_frames[:PLAYBACK_START]
    assert len(frames) == FRAME_COUNT
    assert all(
        frame == authored_frames[(PLAYBACK_START + index) % FRAME_COUNT]
        for index, frame in enumerate(frames)
    )
    assert frames[STILL] == authored_frames[SOLVED_START] == authored_frames[0]
    assert frames[0] != frames[STILL]
    metadata = {"family": family, "fps": FPS, "frames": frames, "still": STILL}
    # Match the repository formatter: each fixed two-codepoint pair stays inline.
    formatted = re.sub(
        r"\[\s+(\d+),\s+(\d+)\s+\]", r"[\1, \2]", json.dumps(metadata, indent=2)
    )
    return output.getvalue(), (formatted + "\n").encode()


def check_scene():
    original = initial_cubies()
    assert len(original) == 26
    assert sum(len(stickers) for _, stickers in original) == 54
    assert len(SCRAMBLE) == len(SOLVE) == 5
    assert all(
        axis in (0, 1, 2) and layer in (-1, 1) and direction in (-1, 1)
        for axis, layer, direction in SCRAMBLE
    )
    assert all(first[0] != second[0] for first, second in pairwise(SCRAMBLE))
    cubies = original
    scrambled_states = [original]
    for move in SCRAMBLE:
        cubies = apply_move(cubies, move)
        assert cubies != original and cubies != scrambled_states[-1]
        scrambled_states.append(cubies)
    assert cubies != original
    assert pose(PLAYBACK_START)[0] == cubies
    assert (
        sum(
            normal != NORMALS[color]
            for _, stickers in cubies
            for normal, color in stickers
        )
        >= 12
    )
    for index, move in enumerate(SOLVE):
        cubies = apply_move(cubies, move)
        assert cubies == scrambled_states[-2 - index]
    # Every cubie's position and identity-bearing sticker normals return exactly.
    assert cubies == original == pose(FRAME_COUNT - 1)[0] == pose(FRAME_COUNT)[0]
    assert pose((PLAYBACK_START + STILL) % FRAME_COUNT)[0] == original
    assert raw_scene(0) == raw_scene(FRAME_COUNT - 1) == raw_scene(FRAME_COUNT)
    assert raw_scene(0) != raw_scene(PLAYBACK_START)
    assert ease(0) == 0 and ease(1) == 1
    assert all(ease(i / 100) < ease((i + 1) / 100) for i in range(100))
    for scene in scenes():
        assert scene
        for vertices, rgb, _ in scene:
            assert len(vertices) == 4 and len(rgb) == 3
            assert all(0 <= channel <= 255 for channel in rgb)
            for x, y in vertices:
                assert math.isfinite(x) and math.isfinite(y)
                assert 29 <= x <= WIDTH - 29
                assert DESCENT + 29 <= y <= ASCENT - 29


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="rebuild in memory and fail if checked-in assets differ",
    )
    args = parser.parse_args()
    check_scene()
    font, metadata = build_font()
    assert (font, metadata) == build_font(), "build is not byte-for-byte deterministic"
    reopened = TTFont(io.BytesIO(font))
    assert reopened["OS/2"].fsType == 0
    meta = json.loads(metadata)
    expected = {cp for frame in meta["frames"] for cp in frame}
    assert set(reopened.getBestCmap()) == expected
    assert all(
        reopened["hmtx"][name][0] == ADVANCE for name in reopened.getBestCmap().values()
    )
    assert all(len(frame) == 2 and frame[1] == 0x20 for frame in meta["frames"])
    assert "COLR" not in reopened and "CPAL" not in reopened
    assert set(reopened["sbix"].strikes) == set(STRIKES)
    for ppem, strike in reopened["sbix"].strikes.items():
        for cp in expected - {0x20}:
            name = reopened.getBestCmap()[cp]
            bitmap = strike.glyphs[name]
            assert bitmap.graphicType == "png "
            assert (bitmap.originOffsetX, bitmap.originOffsetY) == (0, 0)
            image = Image.open(io.BytesIO(bitmap.imageData))
            assert image.mode == "RGBA" and image.size == (
                round(WIDTH * ppem / UPM),
                ppem,
            )
            assert image.getbbox() and image.getpixel((0, 0))[3] == 0
            glyph = reopened["glyf"][name]
            assert (glyph.xMin, glyph.yMin, glyph.xMax, glyph.yMax) == (
                0,
                DESCENT,
                WIDTH,
                ASCENT,
            )
    for name, contents in (("CubeSpinner.ttf", font), ("cube.json", metadata)):
        path = ASSETS / name
        if args.check:
            if not path.exists() or path.read_bytes() != contents:
                raise SystemExit(
                    f"{path} is stale; run uv run {Path(__file__).as_posix()}"
                )
        else:
            ASSETS.mkdir(exist_ok=True)
            path.write_bytes(contents)
    print(
        f"{'checked' if args.check else 'built'} {meta['family']}: {FRAME_COUNT} frames, {len(expected)} codepoints, {len(font):,} bytes"
    )


if __name__ == "__main__":
    main()
