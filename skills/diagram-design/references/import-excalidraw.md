# Excalidraw import

```sh
python3 <skill-dir>/scripts/excalidraw_extract.py source.excalidraw
python3 <skill-dir>/scripts/excalidraw_extract.py source.excalidraw --json --out structure.json
```

Supported input is saved Excalidraw scene JSON (`.excalidraw` or `.json`, including `.excalidraw.json`). PNG and SVG exports are rejected; use the source scene for structural extraction.

| Argument       | Behavior                                                    |
| -------------- | ----------------------------------------------------------- |
| `file`         | Local scene path                                            |
| `--json`       | Full intermediate representation instead of Markdown digest |
| `--max-rows N` | Rows per digest table; default 40, minimum 1                |
| `--out PATH`   | Write UTF-8 output to a file instead of stdout              |

Exit 0 means success; unreadable, malformed, unsupported, or oversized input returns 2. The parser limits input to 16 MiB, 10,000 scene elements, 2,000 recovered nodes, and 5,000 edges. Duplicate element IDs are rejected, even when one duplicate is deleted; references must have unambiguous identities.

Recovered structure includes common shapes, standalone text, bound labels, frames and membership, groups, positions, basic colors, and line/arrow bindings. Arrowhead direction is preserved, including start-only and bidirectional arrows. Missing bindings remain dangling; proximity alone does not establish an edge.

This is a semantic extraction, not a pixel-faithful recreation. Freehand strokes and unknown elements are discarded. Images and embeds retain placeholder boxes, but their pixels, URLs, and payloads are omitted. Element links and deleted elements are counted and discarded. Rotation, precise routing, sketch texture, and advanced styling are not reproduced. Inspect the discard counts and source visually when these details carry meaning. Preserve important annotations manually rather than treating an omitted stroke or image as empty content.
