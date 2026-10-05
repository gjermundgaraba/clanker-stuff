# draw.io import

```sh
python3 <skill-dir>/scripts/drawio_extract.py source.drawio
python3 <skill-dir>/scripts/drawio_extract.py source.drawio --page all --json --out structure.json
```

Supported input: raw `<mxfile>` or `<mxGraphModel>` XML, compressed draw.io payloads, and draw.io PNG/SVG exports containing embedded diagram data. A flattened PNG/SVG without embedded draw.io data is not supported.

| Argument                                | Behavior                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| `file`                                  | Local source path                                                               |
| `--page N`, `--page NAME`, `--page all` | Zero-based index, case-insensitive page name, or every page; default first page |
| `--json`                                | Full extracted intermediate representation instead of Markdown digest           |
| `--max-rows N`                          | Rows per digest table; default 40, minimum 1                                    |
| `--out PATH`                            | Write UTF-8 output to a file instead of stdout                                  |

All pages are decoded before selection. JSON includes page inventory and selected pages with nodes, edges, geometry, styles, and structural analysis. Exit 0 means extraction succeeded; rejected/unsupported input returns 2. Filesystem errors may surface as Python errors.

The extractor resolves nested positions to absolute coordinates, flattens HTML labels into text, recognizes common shape families, and reports containers, hubs, cycles, and missing endpoints. Custom shapes and vendor icons are structural hints; arbitrary drawing details, original routing, and exact appearance require visual inspection. Do not copy source HTML/style values directly into executable output.

Input is limited to 32 MiB; decompressed payloads are limited to 64 MiB. XML DTD/entity declarations and truncated PNG metadata are rejected. These are parser resource limits, not diagram complexity targets. For a multipage source, inspect the inventory and use the relevant page or separate outputs when the pages tell different stories.
