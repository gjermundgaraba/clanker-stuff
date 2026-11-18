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

    def test_incomplete_html_is_reported(self):
        whole = '<!doctype html><html><head><title>Diagram</title></head><body>' + SVG + '</body></html>'
        self.assertEqual(self.check(whole, '.html'), [])
        self.assertEqual(self.check(whole + '\n<!-- generated -->\n', '.html'), [])
        self.assertEqual(self.check(whole.replace('<title>Diagram', '<title>Using <span> labels'), '.html'), [])
        for source, expected in ((whole[:-len('</body></html>')], 'does not end with </html>'),
                                 (whole.replace('</svg>', ''), '<svg> opens 1 time(s) and closes 0'),
                                 (whole.replace('</title>', ''), '<title> is never closed'),
                                 (whole.replace('Diagram', 'Diagr\ufffdm'), 'U+FFFD')):
            self.assertTrue(any(expected in error for error in self.check(source, '.html')), expected)

    def test_static_paint_past_the_viewbox_is_reported(self):
        def painted(markup, head=''):
            return self.check(SVG.replace('</svg>', head + markup + '</svg>'))
        for markup, side in (('<rect x="90" y="0" width="20" height="5"/>', 'right'),
                             ('<circle cx="50" cy="3" r="9"/>', 'top'),
                             ('<text x="-10" y="20">Label</text>', 'left'),
                             ('<g transform="translate(0, 40)"><line x1="0" y1="0" x2="5" y2="30"/></g>', 'bottom')):
            self.assertTrue(any(f'past the viewBox {side} edge' in error for error in painted(markup)), markup)
        for markup in ('<rect x="0" y="0" width="100" height="50"/>',
                       '<rect x="0" y="0" width="102" height="50"/>',
                       '<defs><rect x="500" width="5" height="5"/></defs>',
                       '<g transform="rotate(45)"><rect x="500" width="5" height="5"/></g>',
                       '<rect x="500" width="5" height="5" display="none"/>',
                       '<rect x="500" width="5" height="5" style="transform: translateX(-500px)"/>'):
            self.assertEqual(painted(markup), [], markup)
        self.assertEqual(painted('<rect class="moved" x="500" width="5" height="5"/>',
                                 '<style>.moved { transform: translateX(-500px) }</style>'), [])

    def test_boxed_text_past_the_width_budget_is_reported(self):
        box = '<rect x="0" y="12" width="100" height="40" fill="#ececec" stroke="#2d3142"/>'
        long_label = '<text x="4" y="32" font-size="10">ABCDEFGHIJKLMNOPQRST</text>'

        def overflow(markup, root=''):
            errors = self.check(SVG.replace('role="img"', 'role="img"' + root).replace('</svg>', markup + '</svg>'))
            return [error for error in errors if 'overflows its' in error]

        for markup, root in ((box + long_label, ''),
                             (box + '<text x="4" y="32">ABCDEFGHIJKLMNOPQRST</text>', ' font-size="10"'),
                             ('<g fill="#ececec" stroke="#2d3142"><rect x="0" y="12" width="100" height="40"/></g>' + long_label, ''),
                             ('<rect x="0" y="12" width="100" height="40" fill-opacity="0" stroke="#2d3142"/>' + long_label, ''),
                             (box + '<text x="4" y="24" font-size="10">AB<tspan x="4" dy="12">ABCDEFGHIJKLMNOPQRST</tspan></text>', ''),
                             (box + '<text x="4" y="32" font-size="10">注文注文注文注文注文注文</text>', '')):
            self.assertTrue(any('overflows its 100px box' in error for error in overflow(markup, root)), markup)
        for markup, root in ((box + '<text x="4" y="32" font-size="10">ABCDEFGHIJ</text>', ''),
                             (box + '<text x="50" y="32" font-size="10">ABCDEFGHIJ</text>', ' text-anchor="middle"'),
                             (long_label, ''),
                             ('<rect x="0" y="12" width="100" height="40" fill="hsl(0 0% 50% / 0%)"/>' + long_label, ''),
                             ('<g opacity="0"><rect x="0" y="12" width="100" height="40" fill="#ececec"/></g>' + long_label, ''),
                             ('<rect width="100%" height="100%" fill="#f5f5f5"/><rect x="0" y="12" width="40" height="40" fill="#f5f5f5"/>' + long_label, ''),
                             (box + '<text x="60" y="32" dx="-40" font-size="10">ABCDEFGHIJ</text>', ''),
                             (box + '<text x="96" y="32" font-size="10">ABCDEFGHIJ</text>', ' direction="rtl"'),
                             ('<style>text.w { font-size: 4px; }</style>' + box + '<text class="w" x="4" y="32">ABCDEFGHIJKLMNOPQRST</text>', ''),
                             ('<style>.box { fill: #f5f5f5; }</style><rect class="box" x="0" y="12" width="100" height="40"/>' + long_label, '')):
            self.assertEqual(overflow(markup, root), [], markup)

    def test_shipped_assets_pass(self):
        for asset in sorted(Path(__file__).resolve().parent.parent.glob('assets/*.html')):
            with self.subTest(asset=asset.name):
                self.assertEqual(verify(asset), [])

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
