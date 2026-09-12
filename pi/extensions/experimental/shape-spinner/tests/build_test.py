# /// script
# requires-python = ">=3.11"
# dependencies = ["fonttools==4.64.0", "pillow==12.2.0"]
# ///
"""Font-builder unit tests without Chrome; uv run tests/build_test.py."""
import base64
import copy
import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import build


def sprite(color):
    images = []
    for size in (32, 64):
        image = Image.new("RGBA", (size, size))
        ImageDraw.Draw(image).rectangle((8, 8, size - 9, size - 9), fill=color)
        output = io.BytesIO()
        image.save(output, format="PNG")
        images.append(base64.b64encode(output.getvalue()).decode())
    return images


class FontBuildTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        working = sprite((40, 180, 220, 160))
        resting = sprite((40, 180, 220, 255))
        cls.rendered = {
            "fps": 50, "seed": "test", "strikes": [32, 64],
            "inks": {"cyan": {"dark": "#28b4dc"}}, "viewbox": 32,
            "browser": "test-browser",
            "animations": {"cube": {"cyan": {"dark": [working] * 400 + [resting]}}},
        }
        cls.font, cls.metadata = build.build(cls.rendered)
        cls.family = json.loads(cls.metadata)["family"]

    def test_font_has_complete_bitmaps_and_fixed_bounds(self):
        meta, _ = build.validate(self.font, self.metadata)
        font = TTFont(io.BytesIO(self.font))
        self.assertEqual(font["name"].getDebugName(1), self.family)
        animation = meta["animations"]["cube"]["cyan"]["dark"]
        sprites = self.rendered["animations"]["cube"]["cyan"]["dark"]
        for codepoint, expected in ((animation["frames"][0], sprites[0]),
                               (animation["still"], sprites[-1])):
            name = font.getBestCmap()[codepoint]
            self.assertEqual(font["glyf"][name].numberOfContours, 2)
            for size, encoded in zip((32, 64), expected):
                actual = font["sbix"].strikes[size].glyphs[name].imageData
                self.assertEqual(Image.open(io.BytesIO(actual)).tobytes(),
                                 Image.open(io.BytesIO(base64.b64decode(encoded))).tobytes())

    def test_provenance_does_not_change_the_font(self):
        font, metadata = build.build({**self.rendered, "browser": "another-browser"})
        self.assertEqual(font, self.font)
        self.assertEqual(json.loads(metadata)["family"], self.family)
        self.assertEqual(json.loads(metadata)["browser"], "another-browser")

    def test_changed_pixels_change_font_identity(self):
        rendered = copy.deepcopy(self.rendered)
        rendered["animations"]["cube"]["cyan"]["dark"][0] = sprite((220, 40, 80, 160))
        _, metadata = build.build(rendered)
        self.assertNotEqual(json.loads(metadata)["family"], self.family)

    def test_changed_metrics_change_font_identity(self):
        with patch.object(build, "ADVANCE", 601):
            _, metadata = build.build(self.rendered)
        self.assertNotEqual(json.loads(metadata)["family"], self.family)

    def test_png_optimization_preserves_rgba(self):
        image = Image.new("RGBA", (16, 16))
        image.putdata([(x, 255 - x, 100, x) for x in range(256)])
        output = io.BytesIO()
        image.save(output, format="PNG")
        optimized = Image.open(io.BytesIO(build.optimize_png(output.getvalue())))
        self.assertEqual(optimized.mode, "RGBA")
        self.assertEqual(optimized.tobytes(), image.tobytes())


if __name__ == "__main__":
    unittest.main()
