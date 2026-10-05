# Medallion / data tiers

Data quality tiers and promotion rules.

Tier cards describe what each layer contains, its guarantees, formats, retention, and access as supported by the inputs. Promotion edges describe transformations or acceptance criteria between tiers. Bronze/Silver/Gold names do not establish those guarantees by themselves. Optional path cards describe write methods, not duplicated tier definitions. Keep lifecycle transitions distinct from data processing.

For tier width `w`, gap `g`, and left pad `L`, `x_i=L+i*(w+g)` and total strip width `N*w+(N-1)*g`. Reserve an arc band above cards. Between tier-top anchors `(x0,y)` and `(x1,y)`, cubic controls `(x0,y-d)` and `(x1,y-d)` give midpoint height `y-0.75*d`; choose `d` to clear the label band. Arc endpoints must match the declared source and destination even for skipped tiers or reverse paths. Compute canvas height from the tallest card plus optional path rows.

Geometry examples: [medallion](../assets/example-medallion.html). These retain an upstream illustration palette; use [design defaults](design.md) for new work.
