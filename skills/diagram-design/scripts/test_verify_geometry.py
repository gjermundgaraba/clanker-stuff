#!/usr/bin/env python3
"""Focused regression tests: python3 -B scripts/test_verify_geometry.py."""
import tempfile
import unittest
from pathlib import Path

from verify_geometry import ASSET_DIR, check

HEAD = ('<svg viewBox="0 0 400 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="t d">'
        '<title id="t">T</title><desc id="d">T.</desc>'
        '<defs><marker id="arrow"><path d="M0,0 L8,3 L0,6 Z"/></marker></defs>')
NODE = '<rect x="100" y="60" width="160" height="64" rx="6" fill="#ececec" stroke="#2d3142"/>'
MASK = '<rect x="240" y="80" width="48" height="12" rx="2" fill="#f5f5f5"/>'


class GeometryTests(unittest.TestCase):
    def findings(self, body):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "diagram.html"
            path.write_text(f"<!doctype html><html><body>{HEAD}{body}</svg></body></html>", encoding="utf-8")
            return check(path)

    def test_label_mask_under_a_later_node_is_reported(self):
        self.assertEqual(len(self.findings(MASK + NODE)), 1)
        self.assertEqual(len(self.findings('<g transform="translate(-200 0)"><rect x="440" y="80" width="48" height="12" fill="#fff"/></g>' + NODE)), 1)
        for body in (NODE + MASK,
                     '<rect x="108" y="68" width="32" height="12" rx="2" fill="#f5f5f5"/>' + NODE,
                     '<rect x="10" y="10" width="48" height="12" fill="#f5f5f5"/>' + NODE):
            self.assertEqual(self.findings(body), [], body)

    def test_connector_routing_is_checked(self):
        diagonal = '<line x1="10" y1="10" x2="90" y2="50" stroke="#000" marker-end="url(#arrow)"/>'
        self.assertTrue(self.findings(NODE + diagonal))
        straight = '<line x1="10" y1="92" x2="100" y2="92" stroke="#000" marker-end="url(#arrow)"/>'
        self.assertEqual(self.findings(NODE + straight), [])

    def test_shipped_assets_pass(self):
        for asset in sorted(ASSET_DIR.glob("*.html")):
            with self.subTest(asset=asset.name):
                self.assertEqual(check(asset), [])


if __name__ == "__main__":
    unittest.main()
