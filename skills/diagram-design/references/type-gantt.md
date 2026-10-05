# Gantt

Tasks with dates, duration, and overlap.

Use one shared time scale. `x(t)=L+W*(t-t0)/(t1-t0)`; task width is `x(end)-x(start)`. State date inclusivity, timezone, or working-day calendar when it changes the interpretation. Milestones have zero duration and use a distinct mark. Progress overlays, if present, encode reported completion rather than elapsed time. Dependencies and critical-path emphasis reflect actual scheduling constraints; do not infer them from touching bars. Group rows by phase or owner without altering dates.

Geometry examples: [gantt](../assets/example-gantt.html). These retain an upstream illustration palette; use [design defaults](design.md) for new work.
