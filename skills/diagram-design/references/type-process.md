# Process

Ordered steps and actor handoffs.

Represent ordered steps with directed edges. Use lanes when actor or team ownership matters; column order is a presentation aid, while edges define the actual allowed sequence. Keep exceptions, parallelism, and loops explicit. Use [flowcharts](type-flowchart.md) for decision-heavy logic.

A reusable lane grid uses label width `L=140`, step pitch `P=112`, header `H=36`, lane pitch `Q=80`, and node size `100×64`. For step `j`, lane `k`: `cx=L+j*P+P/2`, `cy=H+k*Q+Q/2`; canvas width is `L+n_steps*P+right_pad`, height `H+n_lanes*Q+legend_height`. These are adjustable defaults: expand pitches to fit content. Empty cells remain empty; nodes appear only for actual work.

Optional input/output chips represent payload formats, with left=input and right=output explained in a key. Keep format distinct from concern/status color. Use explicit `in`/`out` labels when position alone is ambiguous.

Geometry examples: [process](../assets/example-process.html). These retain an upstream illustration palette; use [design defaults](design.md) for new work.
