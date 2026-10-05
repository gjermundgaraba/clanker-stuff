# Data-platform access matrix

Who can do what on which resource.

Rows represent components/resources and columns roles or groups. Each cell names actual access (`SELECT`, `R/W`, `Admin`, `Login`, `No access`); visual levels summarize these labels without replacing them. Distinguish unknown/unspecified from explicit no access. Do not default omitted source cells to denial unless that is the declared policy. Show permission scope and exceptions accurately; color emphasis must not change the permission category.

A reusable grid has left pad `12`, component column `208`, component-role gap `12`, role width `148`, role gap `16`, right pad `48`. For `N` roles, `W=12+208+12+N*148+max(0,N-1)*16+48`; role `j` starts at `232+j*164`. Data row `k` starts at `140+k*40`, with default height `36`; expand for wrapped labels. Cells express permissions, so no network connectors are needed. A [platform integration view](type-dp-integration.md) answers connectivity instead.

Geometry examples: [dp-security-matrix](../assets/example-dp-security-matrix.html). These retain an upstream illustration palette; use [design defaults](design.md) for new work.
