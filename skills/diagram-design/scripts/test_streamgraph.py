#!/usr/bin/env python3
"""Regression for the example's shared linear stack, not a general chart validator."""
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

EXAMPLE = Path(__file__).resolve().parent.parent / "assets" / "example-streamgraph.html"
VALUES = {
    "Docs": [8, 9, 7, 6, 0, 0, 5, 7, 8, 8, 9, 9],
    "Integration": [34, 36, 38, 42, 44, 47, 49, 52, 54, 56, 59, 61],
    "Unit": [58, 60, 62, 61, 64, 66, 65, 68, 70, 69, 72, 74],
    "End-to-end": [12, 15, 19, 26, 34, 45, 58, 72, 85, 96, 108, 118],
    "Lint": [12, 12, 13, 12, 13, 14, 13, 14, 14, 15, 15, 16],
}
XS = [80 + 80 * j for j in range(12)]


class StreamgraphTests(unittest.TestCase):
    def setUp(self):
        source = EXAMPLE.read_text()
        self.svg = ET.fromstring(source[source.index("<svg"):source.index("</svg>") + 6])
        self.layers = [
            node for node in self.svg.iter()
            if node.tag.endswith("}path") and "data-layer" in node.attrib
        ]

    def boundaries(self, layer):
        # This fixture deliberately uses 24 explicit M/L vertices and a close.
        # Reject curves rather than pretending endpoints can prove their thickness.
        tokens = layer.attrib["d"].split()
        self.assertEqual(tokens[-1], "Z")
        self.assertEqual(len(tokens), 24 * 3 + 1)
        self.assertEqual(tokens[:-1:3], ["M"] + ["L"] * 23)
        points = [(float(tokens[i + 1]), float(tokens[i + 2]))
                  for i in range(0, len(tokens) - 1, 3)]
        upper, lower = points[:12], list(reversed(points[12:]))
        self.assertEqual([x for x, _ in upper], XS)
        self.assertEqual([x for x, _ in lower], XS)
        return [y for _, y in upper], [y for _, y in lower]

    def test_preserves_all_observations_labels_and_printed_totals(self):
        self.assertEqual([layer.attrib["data-layer"] for layer in self.layers], list(VALUES))
        for layer in self.layers:
            name = layer.attrib["data-layer"]
            self.assertEqual(list(map(int, layer.attrib["data-values"].split(","))), VALUES[name])
        periods = [node for node in self.svg.iter() if "data-period" in node.attrib]
        self.assertEqual([node.attrib["data-period"] for node in periods],
                         [f"W{j + 1:02}" for j in range(12)])
        self.assertEqual([int(node.attrib["data-index"]) for node in periods], list(range(12)))
        self.assertEqual([float(node.attrib["x"]) for node in periods], XS)
        for j, node in enumerate(periods):
            self.assertEqual("".join(node.itertext()).strip(), f"W{j + 1:02}")
        legends = {node.attrib["data-layer"]: node for node in self.svg.iter()
                   if "data-total" in node.attrib}
        self.assertEqual(set(legends), set(VALUES))
        for name, values in VALUES.items():
            legend = legends[name]
            self.assertEqual(int(legend.attrib["data-total"]), sum(values))
            self.assertIn(f"{name} · {sum(values)} min", " ".join(legend.itertext()).strip())

    def test_actual_vertices_share_one_scale_center_and_boundaries(self):
        totals = [sum(values[j] for values in VALUES.values()) for j in range(12)]
        envelope_lower = [230 + 1.25 * total / 2 for total in totals]
        expected_lower = envelope_lower
        for layer in self.layers:
            with self.subTest(layer=layer.attrib["data-layer"]):
                upper, lower = self.boundaries(layer)
                self.assertEqual(lower, expected_lower)
                expected_upper = [y - 1.25 * value
                                  for y, value in zip(lower, VALUES[layer.attrib["data-layer"]])]
                self.assertEqual(upper, expected_upper)
                self.assertTrue(all(bottom >= top for top, bottom in zip(upper, lower)))
                expected_lower = upper
        self.assertEqual([(top + bottom) / 2
                          for top, bottom in zip(expected_lower, envelope_lower)], [230] * 12)
        self.assertEqual([bottom - top for top, bottom in zip(expected_lower, envelope_lower)],
                         [1.25 * total for total in totals])

    def test_docs_zero_interval_stays_zero_between_w05_and_w06(self):
        upper, lower = self.boundaries(self.layers[0])
        # The original independent cubic boundaries crossed at x=440 despite
        # correct zero observations. Linear shared boundaries cannot cross.
        for fraction in (0, 0.25, 0.5, 0.75, 1):
            top = upper[4] + fraction * (upper[5] - upper[4])
            bottom = lower[4] + fraction * (lower[5] - lower[4])
            self.assertEqual(bottom - top, 0)


if __name__ == "__main__":
    unittest.main()
