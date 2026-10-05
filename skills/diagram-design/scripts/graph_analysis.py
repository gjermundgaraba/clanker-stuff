"""Shared structural semantics for normalized diagram relationships.

Bidirectional edges carry both directions. Undirected contacts count at both
endpoints without implying a flow entry or terminal, but do not create directed
cycles. Dangling endpoints retain degree evidence; cycle traversal uses only
relationships whose two endpoints exist.
"""

from __future__ import annotations

from typing import Iterable, Iterator, Protocol


class GraphNode(Protocol):
    id: str
    in_degree: int
    out_degree: int


class GraphEdge(Protocol):
    source: str | None
    target: str | None
    bidirectional: bool
    undirected: bool


def finalize_degrees(nodes: Iterable[GraphNode], edges: Iterable[GraphEdge]) -> None:
    by_id = {node.id: node for node in nodes}
    for node in by_id.values():
        node.in_degree = node.out_degree = 0
    for edge in edges:
        source = by_id.get(edge.source or "")
        target = by_id.get(edge.target or "")
        if edge.bidirectional or edge.undirected:
            for endpoint in (source, target):
                if endpoint is not None:
                    endpoint.in_degree += 1
                    endpoint.out_degree += 1
        else:
            if source is not None:
                source.out_degree += 1
            if target is not None:
                target.in_degree += 1


def has_directed_cycle(nodes: Iterable[GraphNode], edges: Iterable[GraphEdge]) -> bool:
    adjacency: dict[str, list[str]] = {node.id: [] for node in nodes}
    for edge in edges:
        if edge.undirected:
            continue
        if edge.source in adjacency and edge.target in adjacency:
            adjacency[edge.source].append(edge.target)
            if edge.bidirectional:
                adjacency[edge.target].append(edge.source)
    white, grey, black = 0, 1, 2
    colors = {node_id: white for node_id in adjacency}
    for start in adjacency:
        if colors[start] != white:
            continue
        colors[start] = grey
        stack: list[tuple[str, Iterator[str]]] = [(start, iter(adjacency[start]))]
        while stack:
            node_id, targets = stack[-1]
            for target in targets:
                if colors[target] == grey:
                    return True
                if colors[target] == white:
                    colors[target] = grey
                    stack.append((target, iter(adjacency[target])))
                    break
            else:
                colors[node_id] = black
                stack.pop()
    return False
