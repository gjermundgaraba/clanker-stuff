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
| Soft    | `#5a6580` | `#949eb2` | Sublabels and boundary labels       |
| Rule    | `#bfc0c0` | `#596071` | Borders and separators              |
| Accent  | `#bf4520` | `#f08a59` | Editorial emphasis                  |
| Link    | `#2e5aa8` | `#739fdf` | Distinct external flow, when needed |

Reserve the accent for a small focal set. Give distinct categories or quantitative series their own consistent encoding when comparison requires it. Include labels, symbols, or line styles when color carries meaning.

Hold each color to every role it plays, measured against the surface it actually sits on: 4.5:1 for text, 3:1 for large text (24px or more, or 18.7px or more at weight 600) and for essential lines, arrows, borders, and data points. Composite a translucent color over its background before measuring, and measure text on a tinted surface against that tint. Decorative rules and tints have no minimum but must never be the only carrier of meaning. On paper, the light defaults measure accent 4.71:1, soft 5.34:1, muted 6.11:1, and link 6.13:1; the dark defaults measure accent 5.21:1, soft 4.78:1, muted 7.07:1, and link 4.76:1. Recheck these when a project supplies its own palette.

Use high-contrast text on accent-filled marks; the upstream `ink-strong` default is `#111111` in both skins, but check the actual foreground/background pair. Use a serif title, sans-serif node names, and monospace only for technical labels such as ports, code, or field types. Instrument Serif, Geist, and Geist Mono are upstream's preferred families; the [starter](../assets/template.html) uses offline system fallbacks. Supplied branding takes precedence. Match the script of the actual labels; CJK text needs a suitable font and often more space.

For Cyrillic titles, Instrument Serif needs a Cyrillic-capable serif fallback such as Noto Serif (before any CJK serif). Keep printed identifiers exactly as supplied—do not transliterate or re-case cabinet, port, or physical labels. Measure wide Cyrillic glyphs and mixed-script punctuation with actual fonts rather than relying on a per-character average.

Set type sizes for the final displayed figure, not just the SVG coordinate space. Scaling a 960-unit SVG into a 480px column halves the apparent text size. Measure long labels with the fonts that actually render, wrap or expand nodes, and leave space for descenders. For slides, reduce clutter before shrinking labels.

Exact reusable markup and port mechanics: [primitives-core.md](primitives-core.md). Read [layout-budget.md](layout-budget.md) for density planning and narrow-screen/print handling.

## Composition

Start from [template.html](../assets/template.html) or adapt the nearest example. The starter's SVG is self-contained: its diagram colors and system font choices are explicit within the subtree, while the HTML wrapper handles page layout. The other HTML examples demonstrate geometry and content hierarchy but rely on page CSS and custom properties; they are not standalone SVGs. Their labels and decorative wrappers are replaceable. For SVG delivery, author the chosen geometry directly with internal styles/definitions or explicit attributes. The starter's background, border treatment, type, and spacing are defaults.

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

For standalone SVG, keep its styles, tokens, font choices, and referenced resources inside the SVG, independent of page CSS. For standalone HTML, inline the required page resources. Offline delivery requires system fonts or embedded font data and no remote assets. Browser-loaded fonts are not automatically embedded when adapting an inline diagram; see [export](export.md). Use actual text for labels so they remain selectable and accessible.

The structural checker detects supported markup errors, truncated HTML, mojibake, and static shapes or text anchors past the viewBox. It skips paths and anything moved by CSS or a non-translate transform, and it cannot establish readability, factual correctness, or visual clearance. Inspect the rendered figure, especially arrow endpoints, label wrapping, contrast, and clipping at the requested size.
