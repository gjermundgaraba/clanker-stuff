# Editorial design

Use this reference for the default visual treatment and shared SVG mechanics. The type references supply specialized geometry. Adapt these defaults to the user's design system and the destination.

## Palette and type

Use semantic tokens so branding changes remain local to the artifact. The defaults adapted from upstream are:

| Role    | Light     | Dark      | Purpose                             |
| ------- | --------- | --------- | ----------------------------------- |
| Paper   | `#f5f5f5` | `#2d3142` | Background and label masks          |
| Surface | `#ececec` | `#393e53` | Group or secondary fill             |
| Ink     | `#2d3142` | `#f5f5f5` | Primary text and strokes            |
| Muted   | `#4f5d75` | `#bfc0c0` | Secondary labels and connections    |
| Rule    | `#bfc0c0` | `#596071` | Borders and separators              |
| Accent  | `#eb6c36` | `#f08a59` | Editorial emphasis                  |
| Link    | `#2e5aa8` | `#6a95d8` | Distinct external flow, when needed |

Reserve the accent for a small focal set. Give distinct categories or quantitative series their own consistent encoding when comparison requires it. Include labels, symbols, or line styles when color carries meaning.

Use a serif title, sans-serif node names, and monospace only for technical labels such as ports, code, or field types. Instrument Serif, Geist, and Geist Mono are upstream's preferred families; the [starter](../assets/template.html) uses offline system fallbacks. Supplied branding takes precedence. Match the script of the actual labels; CJK text needs a suitable font and often more space.

Set type sizes for the final displayed figure, not just the SVG coordinate space. Scaling a 960-unit SVG into a 480px column halves the apparent text size. Measure long labels with the fonts that actually render, wrap or expand nodes, and leave space for descenders. For slides, reduce clutter before shrinking labels.

## Composition

Start from [template.html](../assets/template.html) or adapt the nearest example. Examples demonstrate geometry and content hierarchy; their labels and decorative wrappers are replaceable. The starter's background, border treatment, type, and spacing are defaults.

Let the strongest relationship set the reading direction. Use containment for membership, lanes for responsibility, and edges for actual relationships. Keep legends outside the active routing area when a legend is useful. A title and diagram may be the complete page; add explanatory sections only when they contribute information.

Use a regular spacing rhythm, but allow geometry and text metrics to determine exact coordinates. Node counts are a readability decision, not a deletion rule. When aggregating repeated components, preserve multiplicity and any meaningful differences. Keep source data and essential relationships intact.

## Connectors and layering

For box-based system diagrams, rounded orthogonal paths often make routes easier to follow. Other grammars need other geometry: loops use arcs, Sankey flows use bands, and quantitative charts use data-driven marks.

- Route through open space and terminate at the true endpoint. Use separate attachment points when multiple edges would otherwise hide one another.
- Keep labels clear of strokes and neighboring nodes. A paper-colored label mask prevents a line from bleeding through text; leave a visible gap when positioning the label alongside a line. A roughly 6–10 unit gap is a useful starting point at typical document scale.
- Paint background and zones first, then connectors, then opaque nodes, then labels and annotations. Transparent node fills alone will expose paths underneath; use a paper underlay where necessary.
- A crossing must not look like a junction. Reroute, add a gap, or use a small bridge on the secondary path. Mark intentional junctions explicitly.
- Distinguish return, asynchronous, optional, blocked, and primary flows according to the subject. A dashed stroke needs a consistent meaning; avoid using it merely to disguise an obstructed route.

For a right/down elbow from `(x1,y1)` to `(x2,y2)` via `mid`, with sufficient room for radius `r`:

```svg
<path d="M x1,y1 H mid-r Q mid,y1 mid,y1+r
         V y2-r Q mid,y2 mid+r,y2 H x2"
      fill="none" stroke="var(--muted)" marker-end="url(#figure-arrow)"/>
```

Flip signs for upward travel and reduce the radius when segments are short. See [architecture](type-architecture.md) for attachment and crossing examples. Define only the markers the figure uses and prefix their IDs for the figure.

## Accessible, portable output

Give each informative SVG a descriptive `<title>` and `<desc>` referenced by `aria-labelledby`, with `role="img"`. Prefix IDs per figure so multiple inline diagrams do not collide. Describe the subject and relationships, not a shape-by-shape inventory. Decorative SVG can use `aria-hidden="true"`.

Keep HTML CSS inline and SVG resources internal when a standalone artifact is needed. Offline delivery requires system fonts or embedded font data and no remote assets. Browser-loaded fonts are not automatically embedded in exported SVG; see [export](export.md). Use actual text for labels so they remain selectable and accessible.

The structural checker detects supported markup errors; it cannot establish readability, factual correctness, or visual clearance. Inspect the rendered figure, especially arrow endpoints, label wrapping, contrast, and clipping at the requested size.
