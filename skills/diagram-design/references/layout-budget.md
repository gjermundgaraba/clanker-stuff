# Layout and density

Use these starting points to plan a readable figure at its destination size, not to delete meaningful source content. Shared styling lives in [design.md](design.md); the [type references](types.md) own specialized geometry and data encodings.

## Geometry rhythm

A 4-unit grid works well for node origins, box sizes, gaps, and padding. Typical widths are 120, 144, 160, 200, 240, and 320; gaps 20–48; padding 8–16; radii 4–8. Data-derived positions, text baselines, font sizes, markers, stroke widths, and half-pixel stroke alignment need not follow that grid.

Measure labels with the font that renders. A per-character estimate is only a draft budget; proportional fonts, wide Cyrillic glyphs, CJK scripts, and mixed punctuation can exceed it.

## Complexity planning

A small box-and-arrow overview often fits about 9 nodes and 12 edges with one or two focal elements. More content may need grouping, a larger canvas, detail panels, or linked views. Preserve multiplicity, meaningful differences, and complete relationships when aggregating; disclose omissions or grouping.

Useful starting points by visual grammar:

| Grammar                    | Starting density                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------- |
| Architecture delta         | 8 unique components, 10 relationships, 8 change-ledger entries across both snapshots  |
| Sequence                   | 5 lifelines, 12 messages; shallow combined fragments                                  |
| Swimlane                   | 5 lanes                                                                               |
| Nested, tree, org chart    | 4–6 levels, with readable labels at each tier                                         |
| Layer stack                | 6 bands                                                                               |
| Exploded axonometric       | 2–5 parts or levels, 3 detail tiers, 1 focal part                                     |
| Axonometric plan           | 8 tagged rooms/buildings, up to 40 small boxes, 1 focal room/building                 |
| Lifecycle phase map        | 4–5 primary phases, 2 wait/recovery states, 2 terminal states, about 10 transitions   |
| Heatmap                    | 3–7 rows, 3–8 columns; enlarge the frame before labels become unreadable              |
| Marimekko                  | 8 categories, 5 series; group a long tail only when disclosed and appropriate         |
| Streamgraph                | 3–24 periods, 2–6 layers                                                              |
| Radar, polar, Venn         | About 5 radar axes/series, 8 polar categories, or 3 intersecting sets                 |
| Bar, waterfall, treemap    | About 8 primary marks                                                                 |
| Line, scatter, Gantt       | About 5 lines, 30 points, or 12 tasks                                                 |
| Sankey                     | 3 stages, 8 nodes, 12 flows                                                           |
| Fishbone                   | 6 cause categories, 3 sub-causes each                                                 |
| Kanban, story map          | About 5 columns/activities and 12 cards                                               |
| Deployment, dependency     | About 6–9 nodes and 8–14 relationships                                                |
| UML class, database schema | About 5–7 entities; expose required members and keys rather than arbitrary truncation |

Density limits are not correctness checks. A dense source may remain useful as a faithful technical view even when an overview is also needed. Quantitative categories and zeros must never disappear just to satisfy a visual budget.

## Responsive and printed layout

Keep a dense SVG at a width where its text remains readable. If the intended display is its native viewBox width, use that width as the CSS minimum and place it in a local horizontal scroller rather than letting the entire page overflow.

```css
.frame {
  width: 100%;
  max-width: 100%;
  min-width: 0;
}
.diagram-container {
  width: 100%;
  overflow-x: auto;
}
svg {
  width: 100%;
  min-width: 960px;
  height: auto;
  display: block;
}
@media print {
  .diagram-container {
    overflow: visible;
  }
  svg {
    min-width: 0;
  }
}
```

This example assumes a 960-unit viewBox. Match the actual canvas and intended text scale; do not copy a smaller minimum into a larger diagram unknowingly. Give the scroller an accessible label, keyboard access, and a visible hint where needed. A flex/grid item may require `min-width: 0` to allow its scroller to work. Put the scroller inside any clipped ancestor.

Place print overrides after screen SVG rules so they win. Print must show the whole figure, not a clipped scrolling viewport. For PNG screenshots, release ancestor clipping before capturing the diagram element; see [export.md](export.md).

A title and diagram can be a complete page. Add optional summaries or cards only when they convey information, vary emphasis to reflect meaning, and avoid decorative chrome that competes with the relationships.
