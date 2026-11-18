# PlantUML import

```sh
python3 <skill-dir>/scripts/plantuml_extract.py source.puml
python3 <skill-dir>/scripts/plantuml_extract.py README.md --diagram all --json --out structure.json
```

Input may be `.puml`, `.plantuml`, `.pu`, or Markdown with fenced `plantuml` / `puml` blocks, as UTF-8 with or without a byte-order mark. Supported kinds are `sequence` and `class`; other kinds (activity, state, component, `@startgantt`, `@startmindmap`, and so on) fail with the supported-kinds message rather than being approximated. This is a bounded subset parser, not PlantUML itself; it never invokes `plantuml.jar`, Graphviz, or a PlantUML server.

| Argument | Behavior |
| --- | --- |
| `file` | Local source path |
| `--diagram N`, `--diagram all` | Zero-based `@startuml` or fenced block, or every block; default first block |
| `--json` | Full intermediate representation instead of Markdown digest |
| `--max-rows N` | Rows per digest table; default 40, minimum 1 |
| `--out PATH` | Write UTF-8 output to a file instead of stdout |

Exit 0 means success; unreadable, unsupported, malformed, or oversized selected input returns 2. Only selected blocks must parse: an unselected block that fails is listed as `[N] unparsed: <reason>`. Each block must close with its own marker. Sources are limited to 4 MiB with bounded participant, class, edge, and statement sizes.

Sequence diagrams keep lifelines, numbered message order, activation spans tied to the message they follow, combined fragments (`alt`, `opt`, `loop`) with the message span of each branch, notes with the participants and message they attach to, and dividers. Long, styled, and direction-hinted arrows are read whole; lost (`->x`) and circle (`->o`) messages keep that arrowhead, and `-[hidden]-` links are counted as layout hints. Arrow ends resolve by code as PlantUML does, so an `as` display name is a label and a participant may be declared inline. Class diagrams keep classifier names, stereotypes, members, relationship kind (inheritance, composition, aggregation, association), cardinality at each end, and navigability; classes inside a package get a package-qualified id so same-named classes stay separate. PlantUML has no source coordinates, so the digest reports `source layout: none`.

`!include`, `!includeurl`, `!includesub`, `!import`, `!theme` from a URL, executable `!function` / `!procedure` bodies, `%load_json`, and `!define` expanding to includes fail closed with `include not inlined`; never fetch or invent that content. Skinparams, local themes, colors, sprites, and Creole/HTML markup are counted and dropped; notes and stereotypes become inert text. A chained or malformed arrow, or an arrow the IR does not model (`x--`, `}--`, `[->`, `->]`), fails with its line number instead of being redrawn as something else; report it and do not drop the statement.

Redraw sequence sources with the [sequence](type-sequence.md) grammar and class sources with [UML class](type-uml-class.md), preserving message order, activations, fragments, members, cardinality, and navigability. Discard the source skin and report what was merged, collapsed, or dropped, starting from the digest's discard counts.
