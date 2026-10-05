# Polar rays

Cyclic categories with one nonnegative measure.

Use evenly spaced category angles when the cycle has equal steps; preserve unequal angular intervals when angle represents actual time or direction. Independent rays encode magnitude without connecting unrelated categories into a filled polygon.

For `N` equal categories, `theta_i=start+2*pi*i/N`, `r_i=R*v_i/S`, `x_i=cx+r_i*cos(theta_i)`, `y_i=cy+r_i*sin(theta_i)` on a common linear scale from 0 to `S>0`. State angular ordering, units, and scale. At zero, draw no magnitude ray or displaced endpoint; retain the category label and print zero. Do not invent a minimum hub radius. Negative values require a different encoding. Use a bar chart when precise comparisons matter more than cyclic structure.

Geometry examples: [polar](../assets/example-polar.html). These retain an upstream illustration palette; use [design defaults](design.md) for new work.
