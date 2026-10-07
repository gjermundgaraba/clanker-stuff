# Deliver HTML, SVG, or PNG

Match the requested format and destination. For SVG delivery, author a valid self-contained `.svg` file directly from the outset. HTML with inline SVG is a legitimate format for explanatory text, interaction, or a responsive page; arbitrary HTML-to-SVG conversion is not a supported delivery path. Use external assets when appropriate to an HTML destination; make the deliverable self-contained when the user requests standalone/offline output.

## SVG

Write valid SVG XML with `xmlns="http://www.w3.org/2000/svg"`, a finite `viewBox`, and explicit dimensions when the consumer needs a fixed size. Keep diagram metadata, referenced definitions, and styling inside the SVG. Define any CSS tokens and font choices within the SVG, or use explicit presentation attributes; do not depend on a surrounding HTML page. Use system fonts or permitted embedded font data and embed other required resources. Include an accessible name and description, for example:

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 400"
     role="img" aria-labelledby="diagram-title" aria-describedby="diagram-desc">
  <title id="diagram-title">Request processing</title>
  <desc id="diagram-desc">A client sends a request to the API, which reads from storage.</desc>
  <!-- Definitions and diagram geometry -->
</svg>
```

The [starter](../assets/template.html) includes a self-contained SVG subtree with explicit diagram colors and system font choices; its HTML wrapper supplies page layout only. The other bundled HTML examples are geometry and composition references: they rely on page CSS and custom properties, so their SVG subtrees are not standalone deliverables. When using their geometry for SVG output, author the needed styles and definitions within the new SVG rather than copying the subtree alone.

Prefix authored IDs per figure and update fragment references consistently when combining diagrams in one document. There is no automatic CSS scoping or ID renaming. XML-escape text and attributes; HTML-only named entities need replacement with Unicode or XML-compatible escapes. Check the SVG as its own file in the destination renderer, not only inline in a browser page.

### Optional browser adaptation

For an existing inline diagram, browser DOM access can help adapt a known static figure. Copy the complete SVG subtree and its referenced `<defs>`, then resolve its actual dependencies. `svg.outerHTML` alone does not embed computed styles, fonts, assets, or definitions outside the subtree. HTML CSS inheritance and JavaScript do not automatically survive detachment. This is bounded, task-specific adaptation, not a generic faithful HTML-to-SVG converter.

For a known static inline diagram, this browser-console expression copies a limited set of computed presentation styles onto a clone. Adapt the selector if the page contains several SVGs. A browser automation tool with DOM evaluation can run the same expression. Save its returned string as UTF-8 `.svg` only after reviewing dependencies and inspecting the detached result; it is not a fidelity guarantee.

```js
(() => {
  const source = document.querySelector('svg[role="img"]');
  if (!source) throw new Error("Diagram SVG not found");
  const copy = source.cloneNode(true);
  const originals = [source, ...source.querySelectorAll("*")];
  const clones = [copy, ...copy.querySelectorAll("*")];
  const properties = [
    "color",
    "fill",
    "fill-opacity",
    "fill-rule",
    "stroke",
    "stroke-width",
    "stroke-opacity",
    "stroke-dasharray",
    "stroke-dashoffset",
    "stroke-linecap",
    "stroke-linejoin",
    "opacity",
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "letter-spacing",
    "word-spacing",
    "text-anchor",
    "dominant-baseline",
    "paint-order",
    "visibility",
    "display",
    "marker-start",
    "marker-mid",
    "marker-end",
    "clip-path",
    "mask",
    "filter",
  ];
  originals.forEach((node, i) => {
    const style = getComputedStyle(node);
    properties.forEach((property) => {
      let value = style.getPropertyValue(property);
      // Browsers may expand same-document fragment URLs to absolute URLs.
      value = value.replace(/url\(["']?([^"')]+)["']?\)/g, (match, ref) => {
        const url = new URL(ref, document.baseURI);
        return url.hash && url.href.split("#")[0] === location.href.split("#")[0]
          ? `url("${url.hash}")`
          : match;
      });
      if (value) clones[i].style.setProperty(property, value);
    });
  });
  copy.querySelectorAll("style, script").forEach((node) => node.remove());
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  return new XMLSerializer().serializeToString(copy);
})();
```

This snapshots computed colors and font choices, including values inherited through CSS variables; it does not embed the font files. For a diagram relying on web fonts, include its needed `@font-face` data inside SVG styles when embedding is permitted, or choose a system font and recheck line breaks. The snippet does not capture pseudo-elements, CSS transforms or CSS-defined geometry, animation state, `foreignObject` layout, or external definitions reliably. Review those separately; when the goal is the rendered appearance rather than editable SVG, prefer a browser PNG capture.

For offline output, embed needed resources or replace them with suitable local geometry/system fonts. Check the standalone SVG in its destination renderer; font metrics and support for filters, CSS, and `foreignObject` vary.

## Exact frames and print sizing

Set the canvas for its actual destination before laying out the content. A few useful upstream landscape starting frames (SVG units treated as CSS pixels at 96 dpi) are:

| Destination                | ViewBox         | Typical raster scale                                  |
| -------------------------- | --------------- | ----------------------------------------------------- |
| Inline document            | `0 0 960 600`   | 2×                                                    |
| Wide document / 16:9 slide | `0 0 1280 720`  | 2×                                                    |
| 4:3 slide                  | `0 0 1200 900`  | 2×                                                    |
| Social preview             | `0 0 1200 632`  | Match the platform’s actual required pixel dimensions |
| Square social image        | `0 0 1080 1080` | Match the requested frame                             |
| A4 landscape               | `0 0 1120 792`  | 3×                                                    |
| A3 landscape               | `0 0 1584 1120` | 3× → 4752×3360                                        |
| Letter landscape           | `0 0 1056 816`  | 3×                                                    |

These are layout presets, not guarantees of physical print size or a platform’s current specification. Honor exact dimensions supplied by the user. For physical print, set explicit SVG dimensions in mm/inches or configure the print/render scale. Keep outer margins and legend clearance, and increase type sizes for presentations instead of merely enlarging the coordinate frame. A `fit` canvas can be derived from actual content bounds plus padding when no fixed aspect ratio is needed.

For a native-width technical figure, match CSS `min-width` to the viewBox width inside a local horizontal scroller; release both minimum width and clipping for print. See [layout-budget.md](layout-budget.md). Recheck the final text scale and layout rather than assuming one numeric preset makes every diagram readable.

## HTML with inline SVG

Use a complete UTF-8 HTML document with a descriptive title and viewport metadata. Include the SVG directly so it remains inspectable and accessible. Keep labels readable at the expected viewing size. For a responsive illustration, `svg { max-width: 100%; height: auto; }` often suffices; a dense technical diagram may need a local scroll container instead of shrinking all text. For offline delivery, inline required CSS, scripts, and assets and verify with networking disabled.

## PNG

Render the completed SVG/HTML with a browser or renderer available in the current environment. For direct SVG, an installed `rsvg-convert` provides a simple route:

```sh
rsvg-convert --output diagram.png diagram.svg
```

Set the SVG's dimensions to the requested pixel frame, or use the renderer's sizing options. Inspect the PNG because font and SVG feature support can differ between renderers.

The skill never installs rendering dependencies automatically. Use an approved renderer and compatible browser already provisioned by the host environment; report unavailable capabilities.

With an available browser automation API, target the diagram element for a PNG screenshot at the requested pixel size; wait for fonts/images and put animation into the intended complete frame. Release clipping ancestors of the SVG (local scrollers and `overflow: hidden` wrappers) for a full element screenshot, or the right edge can remain blank even when the PNG has the expected width. Prefer bounded waits for network and fonts; if a font request stalls, stop the load, capture only when a usable fallback is available, and disclose the fallback typography. Treat other rendering errors as failures, not a successful export.

If the API supports only viewport screenshots, size the viewport to the diagram and crop using an available image tool. Confirm screenshot dimensions and background/transparency before delivery.

When a headless browser executable is installed and usable, a CLI screenshot is another route. For example, on macOS with Google Chrome installed at its standard path:

```sh
diagram_profile=$(mktemp -d)
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --user-data-dir="$diagram_profile" \
  --screenshot="/absolute/path/diagram.png" \
  --window-size=1600,800 --force-device-scale-factor=1 --hide-scrollbars \
  "file:///absolute/path/diagram.svg"
```

Replace the paths and size. This captures the viewport, not an element or automatically tight crop. Match the SVG/page dimensions to it and inspect the result. Remote assets and animation may need explicit readiness control in browser automation. If headless startup fails or hangs, use the available browser screenshot API; do not assume that having Chrome installed guarantees headless rendering in every environment. PNG loses SVG text semantics and accessibility metadata, so supply a text description where the destination supports one.

## Check the actual artifact

```sh
python3 <skill-dir>/scripts/self_check.py diagram.html
python3 <skill-dir>/scripts/self_check.py diagram.svg
# For requested standalone/offline delivery:
python3 <skill-dir>/scripts/self_check.py --strict-offline diagram.svg
```

The checker accepts one or more paths and exits 0 on success or 1 on findings. It checks nondecorative SVG names/descriptions, `role="img"`, finite positive viewBoxes, duplicate IDs, and local `aria-labelledby`, `aria-describedby`, `href`, and CSS `url(#...)` references. SVG files also undergo XML parsing; HTML uses a permissive parser. It does not assess clipping, overlap, text contrast, routing, animation behavior, or general accessibility compliance. Inspect the rendered result for those.

`--strict-offline` flags static resource references outside the file, including relative paths; in-document fragments and data URLs are permitted. Navigation links are permitted. Complex CSS loaders and `srcset` require manual inspection/inlining. This is a dependency check, not a security boundary: it does not analyze JavaScript or nested embedded documents. For interactive offline artifacts, also inspect runtime network activity and exercise the controls without networking.
