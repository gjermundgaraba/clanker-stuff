# Deliver HTML, SVG, or PNG

Match the requested format and destination. An SVG request can be fulfilled directly with an `.svg` file; no HTML intermediary is required. HTML with inline SVG is useful for explanatory text, interaction, or a responsive page. Use external assets when appropriate to the destination; make the deliverable self-contained when the user requests standalone/offline output.

## SVG

Write valid SVG XML with `xmlns="http://www.w3.org/2000/svg"`, a finite `viewBox`, and explicit dimensions when the consumer needs a fixed size. Keep diagram metadata, referenced definitions, and styling inside the SVG. Include an accessible name and description, for example:

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 400"
     role="img" aria-labelledby="diagram-title" aria-describedby="diagram-desc">
  <title id="diagram-title">Request processing</title>
  <desc id="diagram-desc">A client sends a request to the API, which reads from storage.</desc>
  <!-- Definitions and diagram geometry -->
</svg>
```

When extracting an inline SVG from HTML, copy the complete SVG subtree with its referenced `<defs>`. Move applicable page CSS and inherited custom properties into SVG styles/attributes; copy any needed definitions that were outside the subtree and make IDs consistent. HTML CSS inheritance and JavaScript do not automatically survive extraction. If browser DOM access is available, `svg.outerHTML` captures the subtree, but does not embed computed styles, fonts, assets, or external definitions. Review those dependencies before saving. XML-escape text and attributes; HTML-only named entities need replacement with Unicode or XML-compatible escapes.

For a static inline diagram, the following browser-console expression returns an SVG string with common computed presentation styles copied onto each element. Adapt the selector if the page contains several SVGs. A browser automation tool with DOM evaluation can run the same expression; save its returned string as UTF-8 `.svg`.

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

This snapshots computed colors and font choices, including values inherited through CSS variables; it does not embed the font files. For a diagram relying on web fonts, include its needed `@font-face` data inside SVG styles when embedding is permitted, or choose a system font and recheck line breaks. The snippet is a starting point for static SVG: inspect CSS transforms, CSS-defined geometry, animation, `foreignObject`, and external definitions separately. It is not a general page-to-SVG converter.

For offline output, embed needed resources or replace them with suitable local geometry/system fonts. Check the standalone SVG in its destination renderer; font metrics and support for filters, CSS, and `foreignObject` vary.

## HTML with inline SVG

Use a complete UTF-8 HTML document with a descriptive title and viewport metadata. Include the SVG directly so it remains inspectable and accessible. Keep labels readable at the expected viewing size. For a responsive illustration, `svg { max-width: 100%; height: auto; }` often suffices; a dense technical diagram may need a local scroll container instead of shrinking all text. For offline delivery, inline required CSS, scripts, and assets and verify with networking disabled.

## PNG

Render the completed SVG/HTML with a browser or renderer available in the current environment. For direct SVG, an installed `rsvg-convert` provides a simple route:

```sh
rsvg-convert --output diagram.png diagram.svg
```

Set the SVG's dimensions to the requested pixel frame, or use the renderer's sizing options. Inspect the PNG because font and SVG feature support can differ between renderers.

With an available browser automation API, target the diagram element for a PNG screenshot at the requested pixel size; wait for fonts/images and put animation into the intended complete frame. If the API supports only viewport screenshots, size the viewport to the diagram and crop using an available image tool. Confirm screenshot dimensions and background/transparency before delivery.

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
