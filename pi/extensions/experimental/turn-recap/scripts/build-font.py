# /// script
# requires-python = ">=3.11"
# dependencies = ["fonttools==4.64.0", "skia-pathops==0.9.2"]
# ///
"""Build a LOCAL companion font from a licensed, static monospace TrueType font.

uv run build-font.py --source /path/to/font.ttf --out /path/outside/repository --pairs 01,12,...,50
build-font.ts supplies --out and --pairs from the runtime, which owns both.
Does not install fonts, edit terminal configuration, or change the source font.
"""

import argparse
import hashlib
import io
import json
from pathlib import Path

import pathops
from fontTools import subset
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont, newTable

BASE = 0xF2000  # Supplementary PUA-A; outside this project's spinner banks.
# Frames per digit step: an uncapped 260 ms step sampled at 30 fps shows about 8.
STEPS = 8
TIMESTAMP = 3660681600


def serialize(font):
    output = io.BytesIO()
    font.save(output)
    return output.getvalue()


def rectangle(left, bottom, right, top):
    path = pathops.Path()
    pen = path.getPen()
    pen.moveTo((left, bottom))
    pen.lineTo((right, bottom))
    pen.lineTo((right, top))
    pen.lineTo((left, top))
    pen.closePath()
    return path


def frame_glyph(before, after, phase, viewport, cell_height, units_per_em):
    # Font coordinates increase upwards. Incoming ink starts one cell below.
    outgoing = before.transform(translateY=phase * cell_height)
    incoming = after.transform(translateY=(phase - 1) * cell_height)
    combined = pathops.op(outgoing, incoming, pathops.PathOp.UNION)
    clipped = pathops.op(combined, viewport, pathops.PathOp.INTERSECTION)
    pen = TTGlyphPen(None)
    clipped.draw(Cu2QuPen(pen, max_err=units_per_em / 2000))
    return pen.glyph()


def build(source_bytes, pairs):
    font = TTFont(io.BytesIO(source_bytes), recalcTimestamp=False)
    if "glyf" not in font or "fvar" in font:
        raise ValueError(
            "use a static TrueType font (.ttf), not CFF, a collection, or a variable font"
        )
    source_family = font["name"].getBestFamilyName()
    cmap = font.getBestCmap()
    if any(ord(digit) not in cmap for digit in "0123456789"):
        raise ValueError("source font must contain all ten ASCII digits")
    source_names = {digit: cmap[ord(digit)] for digit in "0123456789"}
    advances = {font["hmtx"][name][0] for name in source_names.values()}
    if len(advances) != 1 or min(advances) <= 0:
        raise ValueError("source digits must have the same positive advance width")
    advance = advances.pop()
    upm = font["head"].unitsPerEm
    ascent, descent, gap = (
        font["hhea"].ascent,
        font["hhea"].descent,
        font["hhea"].lineGap,
    )
    if gap != 0:
        raise ValueError(
            "nonzero line gaps need terminal-specific calibration; use a zero-line-gap font"
        )
    if ascent <= 0 or descent > 0:
        raise ValueError("source font has unsupported vertical metrics")
    height = ascent - descent
    viewport = rectangle(0, descent, advance, ascent)
    glyph_set = font.getGlyphSet()
    paths = {}
    for digit, name in source_names.items():
        path = pathops.Path()
        glyph_set[name].draw(path.getPen(glyph_set))
        left, bottom, right, top = path.bounds
        if not (0 <= left < right <= advance and descent <= bottom < top <= ascent):
            raise ValueError(
                f"source digit {digit} does not fit its advance/vertical metrics"
            )
        paths[digit] = path

    # Keep original endpoint glyphs and their TrueType hint programs, including
    # composite dependencies and global hint tables. Intermediate outlines are
    # intentionally unhinted: the original instructions do not describe them.
    metrics = {
        name: getattr(font["OS/2"], name)
        for name in (
            "sTypoAscender",
            "sTypoDescender",
            "sTypoLineGap",
            "usWinAscent",
            "usWinDescent",
            "fsType",
        )
    }
    options = subset.Options()
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 13, 14, 16, 17]
    options.name_legacy = True
    options.name_languages = ["*"]
    options.layout_features = []
    options.drop_tables += ["PfEd"]  # FontForge editor data, not rendering data.
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=range(ord("0"), ord("9") + 1))
    subsetter.subset(font)
    for name, value in metrics.items():
        setattr(font["OS/2"], name, value)
    font["hhea"].ascent, font["hhea"].descent, font["hhea"].lineGap = (
        ascent,
        descent,
        gap,
    )

    order = list(font.getGlyphOrder())
    mapping = {}
    transitions = {}
    for before, after in pairs:
        frames = []
        for step in range(STEPS + 1):
            cp = BASE + len(mapping)
            if step in (0, STEPS):
                name = source_names[before if step == 0 else after]
            else:
                name = f"roll.{before}{after}.{step:02}"
                glyph = frame_glyph(
                    paths[before], paths[after], step / STEPS, viewport, height, upm
                )
                glyph.recalcBounds(font["glyf"])
                font["glyf"][name] = glyph
                font["hmtx"][name] = (
                    advance,
                    glyph.xMin if glyph.numberOfContours else 0,
                )
                order.append(name)
            mapping[cp] = name
            frames.append(cp)
        transitions[before + after] = frames
    font.setGlyphOrder(order)
    FontBuilder(font=font).setupCharacterMap(mapping)

    # Retain source copyright/license/trademark metadata, not its family identity.
    notices = [
        record for record in font["name"].names if record.nameID in (0, 7, 8, 9, 13, 14)
    ]
    font["name"] = newTable("name")
    font["name"].names = notices
    font["head"].created = font["head"].modified = TIMESTAMP
    # Canonicalize once before hashing: this includes outlines, hints, metrics,
    # source notices and cmap, but excludes the derived family name itself.
    font = TTFont(io.BytesIO(serialize(font)), recalcTimestamp=False)
    digest = hashlib.sha256(serialize(font)).hexdigest()[:10]
    family = f"Rolling Digits {digest}"
    names = {
        1: family,
        2: "Regular",
        3: f"RollingDigits;{digest}",
        4: family,
        5: "Version 1.000",
        6: f"RollingDigits-{digest}",
        16: family,
        17: "Regular",
    }
    for name_id, value in names.items():
        font["name"].setName(value, name_id, 3, 1, 0x409)
        font["name"].setName(value, name_id, 1, 0, 0)
    filename = f"RollingDigits-{digest}.ttf"
    manifest = {
        "version": 1,
        "family": family,
        "file": filename,
        "steps": STEPS,
        "sourceFamily": source_family,
        "sourceSha256": hashlib.sha256(source_bytes).hexdigest(),
        "unitsPerEm": upm,
        "advance": advance,
        "ascent": ascent,
        "descent": descent,
        "transitions": transitions,
        "ghostty": f"font-codepoint-map = U+{BASE:X}-U+{max(mapping):X}={family}",
    }
    return serialize(font), manifest


def validate(font_bytes, manifest, source_bytes):
    font = TTFont(io.BytesIO(font_bytes))
    source = TTFont(io.BytesIO(source_bytes))
    cmap = font.getBestCmap()
    expected = {
        cp for frames in manifest["transitions"].values() for cp in frames
    }
    if set(cmap) != expected or any(cp < BASE or cp > 0xFFFFD for cp in cmap):
        raise ValueError("unexpected codepoint mapping")
    if font["name"].getBestFamilyName() != manifest["family"]:
        raise ValueError("font/manifest family mismatch")
    if (
        font["hhea"].ascent != manifest["ascent"]
        or font["hhea"].descent != manifest["descent"]
    ):
        raise ValueError("font/manifest metric mismatch")
    for name in set(cmap.values()):
        glyph = font["glyf"][name]
        glyph.recalcBounds(font["glyf"])
        if font["hmtx"][name][0] != manifest["advance"] or not glyph.numberOfContours:
            raise ValueError(f"empty or incorrectly sized glyph: {name}")
        if not (
            0 <= glyph.xMin < glyph.xMax <= manifest["advance"]
            and manifest["descent"] <= glyph.yMin < glyph.yMax <= manifest["ascent"]
        ):
            raise ValueError(f"glyph outside its cell: {name}")
    for pair, frames in manifest["transitions"].items():
        if len(frames) != manifest["steps"] + 1:
            raise ValueError(f"incomplete transition: {pair}")
        for cp, digit in ((frames[0], pair[0]), (frames[-1], pair[1])):
            name = cmap[cp]
            original = source.getBestCmap()[ord(digit)]
            if (
                font["glyf"][name].getCoordinates(font["glyf"])
                != source["glyf"][original].getCoordinates(source["glyf"])
                or font["hmtx"][name] != source["hmtx"][original]
            ):
                raise ValueError(
                    f"transition endpoint differs from original digit: {pair}"
                )


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    # Digit transitions the runtime rolls through, e.g. "01,12,50".
    parser.add_argument("--pairs", type=lambda text: text.split(","), required=True)
    args = parser.parse_args()
    source = args.source.expanduser().resolve()
    out = args.out.expanduser().resolve()
    # Derivatives may contain licensed outlines and personal license metadata.
    # Keep local builds out of the source tree, including untracked directories.
    root = next(
        (
            parent
            for parent in Path(__file__).resolve().parents
            if (parent / ".git").exists()
        ),
        None,
    )
    if root is not None and (out == root or root in out.parents):
        parser.error(
            "--out must be outside the repository; do not commit derived fonts"
        )
    source_bytes = source.read_bytes()
    font, manifest = build(source_bytes, args.pairs)
    validate(font, manifest, source_bytes)
    out.mkdir(parents=True, exist_ok=True)
    (out / manifest["file"]).write_bytes(font)
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Font: {out / manifest['file']} ({len(font):,} bytes)")
    print(f"Manifest: {out / 'manifest.json'}")
    print(manifest["ghostty"])
    print(
        "Local derivative: source license still applies. Nothing installed or configured."
    )


if __name__ == "__main__":
    main()
