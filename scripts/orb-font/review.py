# Side-by-side fidelity review: reference render (the site's exact paint
# math: z-sorted grayscale circles with alpha, dark theme) vs the built
# font's glyphs rasterized by FreeType. Columns per state: ref/font at
# frame 0, ref/font at the middle frame.
#
# Usage: uv run --with freetype-py --with pillow python scripts/orb-font/review.py [out.png]

import json
import sys
from pathlib import Path

import freetype
from PIL import Image, ImageDraw

HERE = Path(__file__).parent
data = json.loads((HERE / "frames-20.json").read_text())
meta = json.loads((HERE / "orbs-meta.json").read_text())
SIZE = data["size"]
PX = 96
SS = 4  # reference supersample factor

face = freetype.Face(str(HERE / "ThinkingOrbs.ttf"))
# The orb box spans 600/1000 of the em, so render the em larger to make the
# glyph column the same PX square as the reference column.
face.set_pixel_sizes(0, round(PX * 1000 / 600))


def render_ref(frame):
    s = PX * SS / SIZE
    img = Image.new("RGBA", (PX * SS, PX * SS), (7, 7, 7, 255))
    for x, y, r, white, a in frame["dots"]:  # already z-sorted by capture
        g = round((1 - min(1, max(0, white))) * 255)
        layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        d.ellipse(
            [x * s - r * s, y * s - r * s, x * s + r * s, y * s + r * s],
            fill=(g, g, g, round(a * 255)),
        )
        img = Image.alpha_composite(img, layer)
    return img.convert("L").resize((PX, PX), Image.LANCZOS)


def render_font(cp):
    face.load_char(chr(cp), freetype.FT_LOAD_RENDER)
    bmp = face.glyph.bitmap
    img = Image.new("L", (PX, PX), 7)
    if bmp.width and bmp.rows:
        g = Image.frombytes("L", (bmp.width, bmp.rows), bytes(bmp.buffer))
        img.paste(g, (face.glyph.bitmap_left, PX - face.glyph.bitmap_top))
    return img


states = list(data["states"].items())
LABEL = 110
sheet = Image.new("L", (LABEL + PX * 4 + 30, (PX + 8) * len(states) + 24), 7)
d = ImageDraw.Draw(sheet)
d.text((LABEL, 4), "ref f0    font f0   ref mid   font mid", fill=200)
for row, (state, sdata) in enumerate(states):
    y = 20 + row * (PX + 8)
    base = meta["states"][state]["base"]
    mid = len(sdata["frames"]) // 2
    d.text((4, y + PX // 2), state, fill=200)
    sheet.paste(render_ref(sdata["frames"][0]), (LABEL, y))
    sheet.paste(render_font(base), (LABEL + PX + 4, y))
    sheet.paste(render_ref(sdata["frames"][mid]), (LABEL + (PX + 4) * 2, y))
    sheet.paste(render_font(base + mid), (LABEL + (PX + 4) * 3, y))

out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/orb-review.png"
sheet.save(out)
print("wrote", out)
