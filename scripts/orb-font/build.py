# Builds ThinkingOrbs.ttf from frames-20.json and frames-64.json.
#
# Two glyph blocks at the TOP of plane-16 PUA-B: Nerd Fonts v3 shadow
# plane-15 PUA-A, and Apple's SF Symbols occupy plane 16 from U+100000 up,
# so low plane-16 codepoints fall back to SF Pro on macOS. U+10E000+ is
# beyond both.
#   cell    (20px-tuned variant):  U+10E000 + stateIndex*0x100 + frame
#   display (64px-tuned variant):  U+10F000 + stateIndex*0x100 + frame
#
# Each frame glyph is a COLRv0 color glyph: dots at their EXACT original
# radii, layered into alpha buckets (CPAL palette 0 = white-on-dark,
# palette 1 = black-on-light). COLR-aware renderers (browsers, CoreText)
# reproduce the original's per-dot brightness. The base glyph carries a
# monochrome fallback outline for COLR-unaware renderers, with brightness
# folded into radius (ink^0.65, dust below 0.15 dropped) — the best 1-bit
# approximation per review.py comparisons.
#
# Usage: uv run --with fonttools python scripts/orb-font/build.py [--install]
#
# --install additionally installs the font to ~/Library/Fonts and rewrites the
# Ghostty font-codepoint-map line. Without it, the build only writes the TTF
# and metadata into this directory.

import json
import math
import sys
from pathlib import Path

from fontTools.colorLib.builder import buildCOLR, buildCPAL
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

HERE = Path(__file__).parent
# Ghostty/CoreText cache fonts by family+file across config reloads, so each
# build gets a fresh family name ("Thinking Orbs N") and file name, and the
# Ghostty config's codepoint-map line is rewritten to match. Reload with
# cmd+shift+, after building; no Ghostty restart needed.
REV_FILE = HERE / ".fontrev"
REV = int(REV_FILE.read_text()) + 1 if REV_FILE.exists() else 2
FAMILY = f"Thinking Orbs {REV}"
UPM = 1000
ADVANCE = 600  # one-cell mono glyph
ASCENT = 800
DESCENT = -200
CELL_BOX = 880  # cell-set orb square; overhangs the advance so the orb reads larger
DISPLAY_BOX = 600
MIN_R = 2  # font units; smaller circles are invisible noise
INK_GAMMA = 0.65  # fallback-only: fold brightness into radius
INK_CUT = 0.15  # fallback-only: drop ghost dust
LEVELS = [0.26, 0.48, 0.72, 1.0]  # CPAL alpha buckets, painted faint->bright

K = 1 / math.cos(math.pi / 8)


def ink_of(white, a):
    return (1 - min(1, max(0, white))) * min(1, a)


def level_of(ink):
    return min(range(len(LEVELS)), key=lambda i: abs(LEVELS[i] - ink))


def circle(pen, cx, cy, r):
    on = [(cx + r * math.cos(i * math.pi / 4), cy + r * math.sin(i * math.pi / 4)) for i in range(8)]
    off = [
        (cx + r * K * math.cos((i + 0.5) * math.pi / 4), cy + r * K * math.sin((i + 0.5) * math.pi / 4))
        for i in range(8)
    ]
    rnd = lambda p: (round(p[0]), round(p[1]))
    pen.moveTo(rnd(on[0]))
    for i in range(8):
        pen.qCurveTo(rnd(off[i]), rnd(on[(i + 1) % 8]))
    pen.closePath()


def rect(pen, x1, y1, x2, y2, w):
    dx, dy = x2 - x1, y2 - y1
    n = math.hypot(dx, dy)
    if n < 1e-6:
        return
    px, py = -dy / n * w / 2, dx / n * w / 2
    pts = [(x1 + px, y1 + py), (x2 + px, y2 + py), (x2 - px, y2 - py), (x1 - px, y1 - py)]
    pen.moveTo((round(pts[0][0]), round(pts[0][1])))
    for p in pts[1:]:
        pen.lineTo((round(p[0]), round(p[1])))
    pen.closePath()


glyphs = {".notdef": TTGlyphPen(None).glyph(), "space": TTGlyphPen(None).glyph()}
cmap = {0x20: "space"}
order = [".notdef", "space"]
colr_layers = {}
meta = {"fps": None, "states": {}, "display": {}}


def build_set(path, block_base, meta_key, box):
    data = json.loads((HERE / path).read_text())
    meta["fps"] = data["fps"]
    scale = box / data["size"]
    xoff = (ADVANCE - box) / 2
    ytop = 300 + box / 2  # vertically centered between ascent and descent
    for state_index, (state, sdata) in enumerate(data["states"].items()):
        base = block_base + state_index * 0x100
        frames = sdata["frames"]
        assert len(frames) <= 0x100, f"{state}: {len(frames)} frames overflow the block"
        meta[meta_key][state] = {"base": base, "count": len(frames)}
        for i, frame in enumerate(frames):
            name = f"{meta_key}.{state}.{i:03d}"

            # Fallback outline: monochrome, brightness folded into geometry.
            fpen = TTGlyphPen(None)
            for x, y, r, white, a in frame["dots"]:
                ink = ink_of(white, a)
                if ink < INK_CUT:
                    continue
                rr = r * ink**INK_GAMMA * scale
                if rr < MIN_R:
                    continue
                circle(fpen, xoff + x * scale, ytop - y * scale, rr)
            for x1, y1, x2, y2, w, white, a in frame["lines"]:
                ink = ink_of(white, a)
                if ink < INK_CUT:
                    continue
                rect(fpen, xoff + x1 * scale, ytop - y1 * scale, xoff + x2 * scale, ytop - y2 * scale, max(2, w * ink * scale))
            glyphs[name] = fpen.glyph()
            cmap[base + i] = name
            order.append(name)

            # COLR layers: exact geometry, alpha quantized into LEVELS buckets.
            pens = {}
            for x, y, r, white, a in frame["dots"]:
                ink = ink_of(white, a)
                if ink < 0.10 or r * scale < MIN_R:
                    continue
                lv = level_of(ink)
                pen = pens.setdefault(lv, TTGlyphPen(None))
                circle(pen, xoff + x * scale, ytop - y * scale, r * scale)
            for x1, y1, x2, y2, w, white, a in frame["lines"]:
                ink = ink_of(white, a)
                if ink < 0.10:
                    continue
                pen = pens.setdefault(level_of(ink), TTGlyphPen(None))
                rect(pen, xoff + x1 * scale, ytop - y1 * scale, xoff + x2 * scale, ytop - y2 * scale, max(2, w * scale))
            layers = []
            for lv in sorted(pens):  # faint layers first (back-to-front-ish)
                lname = f"{name}.l{lv}"
                glyphs[lname] = pens[lv].glyph()
                order.append(lname)
                layers.append((lname, lv))
            if layers:
                colr_layers[name] = layers


build_set("frames-20.json", 0x10E000, "states", CELL_BOX)
build_set("frames-64.json", 0x10F000, "display", DISPLAY_BOX)

fb = FontBuilder(UPM, isTTF=True)
fb.setupGlyphOrder(order)
fb.setupCharacterMap(cmap)
fb.setupGlyf(glyphs)
metrics = {}
for name in order:
    g = glyphs[name]
    g.recalcBounds(None)
    metrics[name] = (ADVANCE, getattr(g, "xMin", 0))
fb.setupHorizontalMetrics(metrics)
fb.setupHorizontalHeader(ascent=ASCENT, descent=DESCENT)
fb.setupNameTable({
    "familyName": FAMILY,
    "styleName": "Regular",
    "fullName": f"{FAMILY} Regular",
    "psName": f"ThinkingOrbs{REV}-Regular",
    "uniqueFontIdentifier": f"ThinkingOrbs rev {REV};orbs.jakubantalik.com capture",
    "version": f"Version 1.{REV}",
})
fb.setupOS2(
    sTypoAscender=ASCENT,
    sTypoDescender=DESCENT,
    usWinAscent=ASCENT,
    usWinDescent=-DESCENT,
)
fb.setupPost(isFixedPitch=1)
fb.font["COLR"] = buildCOLR(colr_layers)
fb.font["CPAL"] = buildCPAL([
    [(1, 1, 1, lv) for lv in LEVELS],  # palette 0: white dots, dark themes
    [(0, 0, 0, lv) for lv in LEVELS],  # palette 1: black dots, light themes
])

out = HERE / "ThinkingOrbs.ttf"
fb.save(out)
REV_FILE.write_text(str(REV))

# Install under a revision-unique name and point Ghostty's codepoint map at it.
if "--install" not in sys.argv:
    print(f"built family '{FAMILY}' (not installed; pass --install to install and update Ghostty config)")
    raise SystemExit(0)
fonts_dir = Path.home() / "Library/Fonts"
for old in fonts_dir.glob("ThinkingOrbs*.ttf"):
    old.unlink()
installed = fonts_dir / f"ThinkingOrbs-{REV}.ttf"
installed.write_bytes(out.read_bytes())
ghostty_cfg = Path.home() / ".config/ghostty/config"
if ghostty_cfg.exists():
    import re
    cfg = ghostty_cfg.read_text()
    new_line = f"font-codepoint-map = U+10E000-U+10FFFF={FAMILY}"
    cfg2 = re.sub(r"font-codepoint-map = U\+10E000-U\+10FFFF=.*", new_line, cfg)
    if cfg2 != cfg:
        ghostty_cfg.write_text(cfg2)
        print(f"ghostty config updated: {new_line}")
(HERE / "orbs-meta.json").write_text(json.dumps(meta, indent=2))
(HERE / "orbs-meta.js").write_text("window.ORBS_META = " + json.dumps(meta) + ";\n")

cell = sum(s["count"] for s in meta["states"].values())
disp = sum(s["count"] for s in meta["display"].values())
print(
    f"wrote {out} ({out.stat().st_size // 1024} KiB): {cell} cell + {disp} display frames, "
    f"{len(order)} glyphs total, {len(colr_layers)} COLR glyphs"
)
print(f"installed {installed} as family '{FAMILY}'")
