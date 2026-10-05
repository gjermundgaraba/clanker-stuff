# Radar / spider

Comparable multivariate profiles.

Spokes encode dimensions; polygons connect one profile's values in the same dimension order. Normalize unlike units explicitly and use a consistent direction so larger values mean the same thing. Do not imply comparability by silently rescaling each series separately.

For `N` spokes, `theta_i=-pi/2+2*pi*i/N`, `r_i=R*v_i/S`, `x_i=cx+r_i*cos(theta_i)`, `y_i=cy+r_i*sin(theta_i)`. For other domains, normalize explicitly first. Place labels beyond the outer ring and anchor them according to the spoke direction. Polygon area changes with axis order and is not an overall score; avoid interpreting it as one. Use small multiples when overlapping profiles cannot be traced.

Geometry examples: [radar](../assets/example-radar.html). These retain an upstream illustration palette; use [design defaults](design.md) for new work.
