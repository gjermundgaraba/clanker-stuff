# Core SVG primitives

Use these patterns with [design.md](design.md). They supply reusable mechanics, not a requirement that every visual grammar use boxes and orthogonal arrows. Type references own their specialized notation.

## Background and markers

Use a paper background when the output needs one; transparency may be appropriate for embedding. A dotted texture is optional and should not compete with chart marks or surrounding page chrome.

Define only markers used by the figure and prefix every ID:

```svg
<defs>
  <marker id="request-arrow" markerWidth="8" markerHeight="6"
          refX="7" refY="3" orient="auto">
    <polygon points="0 0, 8 3, 0 6" fill="var(--muted)"/>
  </marker>
</defs>
```

Use restrained emphasis for the primary path. Color, dashed strokes, and open/closed heads must have consistent meanings. Bidirectional and undirected relationships are distinct; do not add arrowheads for decoration.

## Ports, paths, and labels

For box-based systems:

1. Leave and enter a box perpendicular to its edge, with a port on the straight portion rather than on a rounded corner. A horizontal path starting on a top edge runs along the border behind the fill and looks like a corner port.
2. For an off-axis connection, rounded orthogonal elbows are often easier to trace. Start around radius 8 and clamp it to available segment lengths. Enter a destination above/below through the facing top/bottom edge. A single-bend route may leave the source through a side edge; see [architecture](type-architecture.md).
3. Fan multiple connectors across an edge. For edge length `L` and `N` ports, a useful offset is `L*k/(N+1)`. Start with 12 units between ports and parallel routes, adapting to box scale.
4. Do not share strokes unless they represent an intentional junction. At crossings, reroute, bridge, or gap one path. Mark actual junctions explicitly.
5. Avoid transit behind a non-endpoint node. If unavoidable, expose the true destination and label the transit semantics; dashes alone cannot establish them.
6. Place labels in open routing space. A paper-colored mask prevents stroke bleed-through, but cannot fix overlap with a later-painted node. Badge masks wholly inside a node are separate from connector labels.

A 6–10 unit visible gap between label mask and stroke is a useful default. A label beside a vertical segment should remain horizontal. Use the full meaningful label; wrap it or expand its space rather than silently shortening content.

```svg
<!-- Stroke lies at y=100; mask ends at 94, leaving a 6-unit gap. -->
<rect x="120" y="82" width="80" height="12" rx="2" fill="var(--paper)"/>
<text x="160" y="91" text-anchor="middle"
      fill="var(--muted)" font-family="ui-monospace, monospace"
      font-size="9">WRITE</text>
```

## Nodes and paint order

Paint background/zones first, connectors next, opaque nodes next, and their labels/annotations last. A transparent styled node needs a paper underlay if routes would otherwise show through.

```svg
<g>
  <rect x="40" y="40" width="160" height="64" rx="6" fill="var(--paper)"/>
  <rect x="40" y="40" width="160" height="64" rx="6"
        fill="var(--surface)" stroke="var(--ink)"/>
  <rect x="48" y="46" width="28" height="12" rx="2"
        fill="var(--paper)" stroke="var(--muted)"/>
  <text x="62" y="55" text-anchor="middle"
        font-size="8" font-family="ui-monospace, monospace">API</text>
  <text x="120" y="77" text-anchor="middle"
        font-size="12" font-weight="600" font-family="system-ui, sans-serif">Order API</text>
  <text x="120" y="94" text-anchor="middle"
        font-size="9" font-family="ui-monospace, monospace">https:443</text>
</g>
```

These type sizes assume native-size display, not a slide shrunk into a small column. Measure labels with actual fonts. Apply supplied styling to the artifact, not to the installed skill.

## Legends and accessible figures

Place a needed legend outside active routing space and include only used encodings. Expand the viewBox for it instead of overlaying it on nodes.

Each informative SVG uses `role="img"`, a descriptive `<title>` and `<desc>`, and local `aria-labelledby`/`aria-describedby` references. Put the title first, prefix IDs per figure, and describe content and relationships rather than geometry. Decorative SVG may use `aria-hidden="true"`.

Run `python3 <skill-dir>/scripts/self_check.py <file>` for supported structural errors, then inspect the rendered artifact. The checker cannot prove routing clearance, clipping, factual correctness, or readability.
