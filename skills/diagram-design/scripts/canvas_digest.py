"""Common report sections for diagrams with explicit canvas geometry."""

from __future__ import annotations

from typing import Any, Protocol, Sequence

from digest_text import escape_inline, escape_table
from graph_analysis import GraphEdge, GraphNode


class CanvasNode(GraphNode, Protocol):
    label: str
    shape: str
    parent: str | None
    depth: int
    children: list[str]
    x: float
    y: float
    w: float
    h: float


class CanvasEdge(GraphEdge, Protocol):
    label: str
    dashed: bool


def append_canvas_summary(
    out: list[str], info: dict[str, Any], bounds: tuple[float, float, float, float]
) -> None:
    x0, y0, x1, y1 = bounds
    out.append(
        f"- source canvas: {int(x1 - x0)}×{int(y1 - y0)} px "
        f"(aspect {((x1 - x0) / (y1 - y0)):.2f})"
        if y1 > y0
        else "- source canvas: empty"
    )
    out.append(
        f"- nodes: {info['nodes_total']} total / {info['nodes_drawable']} drawable "
        f"/ {info['containers']} containers, depth {info['max_depth']}"
    )
    out.append(
        f"- edges: {info['edges_total']} ({info['edges_labeled']} labeled, "
        f"{info['edges_dangling']} dangling), cycle: {info['has_cycle']}"
    )
    out.append(f"- shapes: {info['shapes']}")
    out.append(f"- type candidates: {', '.join(info['type_candidates'])}")
    out.append(
        f"- budget: nodes {'OVER' if info['over_node_budget'] else 'ok'} (max 9), "
        f"edges {'OVER' if info['over_edge_budget'] else 'ok'} (max 12)"
    )


def append_graph_findings(out: list[str], info: dict[str, Any]) -> None:
    if info["hubs"]:
        hubs = ", ".join(
            f"{escape_inline(h['label'] or h['id'])}({h['degree']})"
            for h in info["hubs"]
        )
        out.append(f"- hubs (focal candidates): {hubs}")
    if info["entry_points"]:
        out.append(
            f"- entry points: {', '.join(escape_inline(label) for label in info['entry_points'])}"
        )
    if info["terminals"]:
        out.append(
            f"- terminals: {', '.join(escape_inline(label) for label in info['terminals'])}"
        )
    if info["orphans"]:
        out.append(
            f"- unconnected: {', '.join(escape_inline(label) for label in info['orphans'])}"
        )
    if info["collapsible_groups"]:
        out.append("- collapsible groups (simplify here first):")
        for group in info["collapsible_groups"]:
            kids = ", ".join(escape_inline(label) for label in group["child_labels"])
            out.append(
                f"  - {escape_inline(group['label'])} — "
                f"{group['children']} children: {kids}"
            )


def append_graph_tables(
    out: list[str], nodes: Sequence[CanvasNode], edges: Sequence[CanvasEdge], max_rows: int
) -> None:
    out.append("")
    out.append("### Nodes")
    out.append("")
    out.append("| id | label | shape | depth | parent | deg | box |")
    out.append("|---|---|---|---|---|---|---|")
    listed = [n for n in nodes if n.label or n.children]
    for node in listed[:max_rows]:
        out.append(
            f"| {escape_table(node.id)} | {escape_table(node.label)} | "
            f"{escape_table(node.shape)} | {node.depth} | "
            f"{escape_table(node.parent or '-')} | {node.in_degree}/{node.out_degree} | "
            f"{int(node.x)},{int(node.y)} {int(node.w)}×{int(node.h)} |"
        )
    if len(listed) > max_rows:
        out.append(f"| … | +{len(listed) - max_rows} more (use --json) | | | | | |")

    out.append("")
    out.append("### Edges")
    out.append("")
    out.append("| source | target | label | style |")
    out.append("|---|---|---|---|")
    names = {n.id: (n.label.split("\n")[0] or n.id) for n in nodes}
    for edge in edges[:max_rows]:
        marks = []
        if edge.dashed:
            marks.append("dashed")
        if edge.bidirectional:
            marks.append("bidir")
        if edge.undirected:
            marks.append("undirected")
        out.append(
            f"| {escape_table(names.get(edge.source or '', '?'))} | "
            f"{escape_table(names.get(edge.target or '', '?'))} | "
            f"{escape_table(edge.label) or '-'} | {' '.join(marks) or '-'} |"
        )
    if len(edges) > max_rows:
        out.append(f"| … | +{len(edges) - max_rows} more (use --json) | | |")
