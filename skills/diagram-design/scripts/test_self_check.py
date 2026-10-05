#!/usr/bin/env python3
"""Focused regression tests: python3 -B scripts/test_self_check.py."""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from self_check import verify

SVG = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" role="img" aria-labelledby="name" aria-describedby="description">
<title id="name">Diagram</title><desc id="description">A useful description.</desc>
<defs><marker id="arrow"><path d="M0,0 L1,1"/></marker></defs>
<path marker-end="url(#arrow)" d="M0,0 L10,10"/></svg>'''


class CheckTests(unittest.TestCase):
    def check(self, source=SVG, suffix=".svg", offline=False):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / ("diagram" + suffix)
            path.write_text(source)
            return verify(path, offline)

    def test_svg_and_html(self):
        self.assertEqual(self.check(), [])
        self.assertEqual(self.check('<!doctype html><meta charset="utf-8"><br>' + SVG + '<script>const app = 1;</script>', ".html"), [])
        self.assertEqual(self.check(SVG.replace('aria-labelledby="name"', 'aria-label="Custom label"')), [])
        self.assertEqual(self.check(SVG.replace(' aria-labelledby="name"', '').replace(' aria-describedby="description"', '')), [])

    def test_missing_refs_and_duplicate_ids(self):
        for change, expected in ((('url(#arrow)', 'url(#missing)'), 'missing id: missing'),
                                 (('id="arrow"', 'id="name"'), 'duplicate id: name'),
                                 (('aria-describedby="description"', 'aria-describedby="gone"'), 'missing id: gone')):
            self.assertTrue(any(expected in error for error in self.check(SVG.replace(*change))))

    def test_invalid_metadata(self):
        for old, new, expected in (('viewBox="0 0 100 50"', 'viewBox="0 0 nan 50"', 'finite viewBox'),
                                   ('viewBox="0 0 100 50"', 'viewBox="0 0 -1 50"', 'finite viewBox'),
                                   ('role="img"', '', 'role=img'),
                                   ('>Diagram<', '><', 'accessible name'),
                                   ('>A useful description.<', '><', 'nonempty desc')):
            self.assertTrue(any(expected in error for error in self.check(SVG.replace(old, new))))

    def test_xml_and_decorative_svg(self):
        self.assertTrue(any('invalid SVG XML' in error for error in self.check(SVG.replace('</svg>', ''))))
        self.assertTrue(any('DTD/entity' in error for error in self.check('<!DOCTYPE svg>' + SVG)))
        html = SVG + '<svg aria-hidden="true"><path d="M0,0 L1,1"/></svg>'
        self.assertEqual(self.check(html, '.html'), [])

    def test_external_assets_optional(self):
        for extra in ('<image href="https://example.com/a.png"/>',
                      '<style>path{fill:url(texture.png)}</style>',
                      '<style>@import "theme.css";</style>'):
            source = SVG.replace('</svg>', extra + '</svg>')
            self.assertEqual(self.check(source), [])
            self.assertTrue(self.check(source, offline=True))
        self.assertEqual(self.check(SVG.replace('</svg>', '<image href="data:image/png;base64,AA=="/><a href="https://example.com">Link</a></svg>'), offline=True), [])

    def test_css_fragment_and_escaped_loader(self):
        self.assertTrue(any('missing id: ghost' in error for error in self.check(SVG.replace('url(#arrow)', 'url(&quot;#ghost&quot;)'))))
        source = SVG.replace('</svg>', r'<style>@\69mport "theme.css";</style></svg>')
        self.assertTrue(self.check(source, offline=True))

    def test_cli_status(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'diagram.svg'
            path.write_text(SVG)
            command = [sys.executable, str(Path(__file__).with_name('self_check.py')), str(path)]
            good = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(good.returncode, 0)
            self.assertIn('OK', good.stdout)
            path.write_text(SVG.replace('url(#arrow)', 'url(#missing)'))
            bad = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(bad.returncode, 1)
            self.assertIn('missing id: missing', bad.stdout)


if __name__ == '__main__':
    unittest.main()
