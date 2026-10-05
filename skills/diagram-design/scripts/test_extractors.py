"""Runtime regressions for diagram extraction and shared graph semantics."""

import contextlib
import io
import itertools
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from xml.etree import ElementTree as ET

import drawio_extract as drawio
import excalidraw_extract as excalidraw
import mermaid_extract as mermaid


def drawio_page(cells):
    return drawio.parse_page(ET.fromstring("<diagram><mxGraphModel><root><mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/>" + "".join(cells) + "</root></mxGraphModel></diagram>"), 0)


def vertex(node_id, parent="1", x=0, size=10):
    return f'<mxCell id="{node_id}" vertex="1" value="{node_id}" parent="{parent}"><mxGeometry x="{x}" y="{x}" width="{size}" height="{size}"/></mxCell>'


def drawio_edge(start, end):
    return f'<mxCell id="edge" edge="1" source="A" target="B" style="startArrow={start};endArrow={end}"/>'


def mermaid_diagram(body):
    return mermaid.parse_block(mermaid.SourceBlock(0, body, 1))


def excalidraw_scene(start, end):
    return excalidraw.parse_scene(Path("fixture.excalidraw"), {"elements": [
        {"id": "A", "type": "rectangle"}, {"id": "B", "type": "rectangle"},
        {"id": "ta", "type": "text", "containerId": "A", "text": "A"},
        {"id": "tb", "type": "text", "containerId": "B", "text": "B"},
        {"id": "edge", "type": "arrow", "startBinding": {"elementId": "A"}, "endBinding": {"elementId": "B"}, "startArrowhead": start, "endArrowhead": end},
    ]})


class DrawioTests(unittest.TestCase):
    def test_nested_coordinates_do_not_depend_on_cell_order(self):
        cells = [vertex("outer", x=100, size=40), vertex("inner", "outer", 20, 20), vertex("leaf", "inner", 5)]
        for order in itertools.permutations(cells):
            page = drawio_page(order)
            self.assertEqual((page.node_map["leaf"].x, page.node_map["leaf"].y, page.node_map["leaf"].depth), (125, 125, 2))
            self.assertEqual(drawio.page_bounds(page), (100, 100, 140, 140))

    def test_deep_parent_hierarchy_does_not_use_python_recursion(self):
        page = drawio_page([vertex(str(i + 2), str(i + 1), 1) for i in range(1200)])
        self.assertEqual(page.node_map["1201"].x, 1200)
        self.assertEqual(page.node_map["1201"].depth, 1199)

    def test_cyclic_parent_hierarchy_is_rejected(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
            drawio_page([vertex("A", "B"), vertex("B", "A")])
        self.assertEqual(error.exception.code, 2)

    def test_arrowheads_determine_semantic_endpoints(self):
        for start, end, endpoints, bidirectional, undirected in [
            ("none", "classic", ("A", "B"), False, False),
            ("classic", "none", ("B", "A"), False, False),
            ("classic", "classic", ("A", "B"), True, False),
            ("none", "none", ("A", "B"), False, True),
        ]:
            with self.subTest(start=start, end=end):
                edge = drawio_page([vertex("A"), vertex("B"), drawio_edge(start, end)]).edges[0]
                self.assertEqual((edge.source, edge.target), endpoints)
                self.assertEqual((edge.bidirectional, edge.undirected), (bidirectional, undirected))


class GraphSemanticsTests(unittest.TestCase):
    def test_equivalent_formats_agree_on_degrees_endpoints_and_cycles(self):
        for operator, start, end, heads, cycle in [
            ("-->", None, "arrow", ("none", "classic"), False),
            ("<-->", "arrow", "arrow", ("classic", "classic"), True),
            ("---", None, None, ("none", "none"), False),
        ]:
            with self.subTest(operator=operator):
                examples = [
                    (drawio_page([vertex("A"), vertex("B"), drawio_edge(*heads)]), drawio.analyze),
                    (excalidraw_scene(start, end), excalidraw.analyze),
                    (mermaid_diagram(f"flowchart LR\nA {operator} B"), mermaid.analyze),
                ]
                signals = []
                for graph, analyze in examples:
                    info = analyze(graph)
                    signals.append(([(n.id, n.in_degree, n.out_degree) for n in graph.nodes], info["entry_points"], info["terminals"], info["has_cycle"]))
                self.assertEqual(signals[0], signals[1])
                self.assertEqual(signals[1], signals[2])
                self.assertEqual(signals[0][-1], cycle)
                if operator != "-->":
                    self.assertEqual(signals[0][1:3], ([], []))

    def test_directed_cycle_and_acyclic_chain(self):
        cycle = mermaid_diagram("flowchart LR\nA --> B --> C --> A")
        chain = mermaid_diagram("flowchart LR\nA --> B --> C")
        self.assertTrue(mermaid.analyze(cycle)["has_cycle"])
        self.assertFalse(mermaid.analyze(chain)["has_cycle"])


class MermaidTests(unittest.TestCase):
    def test_header_line_statements_match_multiline_input(self):
        inline = mermaid_diagram('flowchart LR; A["label; intact"] --> B; B --> C')
        multiline = mermaid_diagram('flowchart LR\nA["label; intact"] --> B\nB --> C')
        self.assertEqual(inline.nodes, multiline.nodes)
        self.assertEqual(inline.edges, multiline.edges)
        self.assertEqual(inline.discarded, multiline.discarded)

    def test_unrecognized_meaningful_statement_is_not_silently_dropped(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
            mermaid_diagram("flowchart LR\nnot valid ! syntax")
        self.assertEqual(error.exception.code, 2)

    def test_selecting_a_supported_block_ignores_unsupported_bodies(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "README.md"
            source.write_text("```mermaid\ngantt\n  title Plan\n```\n\n```mermaid\nflowchart LR; A --> B\n```\n")
            command = [sys.executable, "-B", str(Path(mermaid.__file__)), str(source)]
            selected = subprocess.run(command + ["--diagram", "1", "--json"], capture_output=True, text=True)
            self.assertEqual(selected.returncode, 0, selected.stderr)
            output = json.loads(selected.stdout)
            self.assertEqual(output["diagrams_total"], 2)
            self.assertEqual([entry["kind"] for entry in output["inventory"]], ["gantt", "flowchart"])
            self.assertEqual(len(output["diagrams"][0]["edges"]), 1)
            for selection in ("0", "all"):
                result = subprocess.run(command + ["--diagram", selection], capture_output=True, text=True)
                self.assertEqual(result.returncode, 2)
                self.assertIn("unsupported diagram kind", result.stderr)


if __name__ == "__main__":
    unittest.main()
