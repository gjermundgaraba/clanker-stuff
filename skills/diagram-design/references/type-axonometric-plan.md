# Axonometric plan

**Best for:** one floor or one site seen from above at an angle, with what stands on it. An office floor with its rooms and furniture, a campus with its buildings and roads, a warehouse with its zones, a store layout. Use it when the reader needs to see rooms or buildings in relation to each other and how they are used, in a single view.

**Not this type:**

- Parts of one object pulled apart along an axis → **exploded axonometric** (`type-exploded.md`). A plan has one plate and nothing explodes.
- Containment without geography → **nested** (`type-nested.md`).
- Where software runs → **deployment** (`type-deployment.md`).
- A list of rooms and capacities → a table.

## Projection

The same 2:1 dimetric projection as the exploded axonometric, from one function:

```python
def iso(x, y, z, ox, oy):
    """Model point to SVG point. (ox, oy) is where model (0, 0, 0) lands."""
    return ox + x - y, oy + (x + y) / 2 - z
```

Every element is a rounded prism standing on the plate: `r = 0` for walls, furniture, and buildings, `r = w / 2` for a tree canopy. `type-exploded.md` § Projection covers the corner ellipse and the face matrices; The included examples contain projected paths and metadata from the same construction; use their geometry as a worked reference.

## Layout conventions

Geometry and density values below are starting points for the examples, not permission to omit requested content. Adapt styling via [design.md](design.md).

- **Plate:** One floor slab (6 units) or one site (8 units, small corner radius). Everything stands on it, and nothing extends past its edge.
- **Walls:** 6 units thick and cut at desk height, about 22 units, so no wall hides a room. Doors are gaps in a wall. Walls meet without overlapping: run one wall through a junction and stop the other at its face.
- **Furniture and buildings:** Boxes on the plate with the house face shading (`type-exploded.md` § Faces and lines). Heights are to scale with each other. Two footprints never overlap.
- **Flat marks:** Roads, paths, and floor tints sit on the plate's top face as flat fills (`ink` at 0.07) with no thickness. A dashed centre line (`ink` at 0.25, `6,5`) may mark a road.
- **Racks:** Tall shelving is a box of kind `rack` with the house shading, a shelf line every 14 units, and an upright every 30. Run rack rows along x so the reader sees the lit face and the aisles between rows.
- **Trees:** A canopy cylinder 8 units up on a short trunk, canopy top in `rule-solid` light (`#bfc0c0`) or `soft` dark (`#8e98ac`). Trees are planting, so keep them small and off every footprint.
- **Paint order:** The plate first, then flat marks, then every box back to front. Sort with a topological order: box A paints before box B when A lies entirely behind B (`A.x1 <= B.x0` or `A.y1 <= B.y0`) and their screen outlines overlap. A plain `x + y` sort fails on long walls.
- **Frame:** The canvas is 1000 wide and the plate is centred. The viewBox height follows the plate and its tallest box plus a 48px top margin.

### Tags

- Rooms and buildings are named by a horizontal tag: the name in semibold sans-serif 12px above a sublabel in monospace 8px, on an opaque `paper` backing with a `rule` hairline, 32px tall, width rounded up to a multiple of 4.
- A room's tag sits on open floor inside the room. A building's tag sits on its roof. Tags paint after every box so walls never cut them.
- Tags never overlap each other. Move a tag to open floor before you shorten its name.
- One or two words per name. No leader lines and no numbered key.

### Focal element

One room or one building wears the accent. A focal room gets an `accent` tint on its floor and an accent tag; a focal building gets the accent face ramp and an accent tag. Furniture inside a focal room stays neutral, so the accent marks one thing.

## Optional motion

A site can reveal buildings by phase, or a floor plan can reveal furniture and room tags by zone. Use the matching animated examples as optional controller references in `reveal` mode. Give each independently revealed element `data-motion-item`, `data-appear`, and a `data-step` for its phase or zone. Any number of items can share a step; the controller updates each in natural document order. Revealed items drop 16px into place and fade in, inside the 24px limit in `animation.md`.

Keep the plate, flat marks, and boxes in their actual painter order, with tags after all boxes. A motion step does not need to occupy a contiguous group. Grouping is an optional authoring choice only where it preserves that order; do not move geometry across intervening walls or boxes just to collect a phase. Walls and unphased rooms can stay static. The static, no-JavaScript, reduced-motion, print, and export states show the finished site.

## Metadata contract

Keep these declarations alongside the geometry so each element can be reprojected and checked manually:

- The figure: one `<g data-axo-plan data-origin="ox oy">`.
- The plate: one `<g data-plate data-rect="x0 y0 x1 y1 r" data-z="0" data-t="t">`.
- Each box: a `<g data-box>` with `data-rect`, `data-z` (the plate top, or 8 above it for a tree canopy), `data-h`, `data-kind` (`wall`, `furniture`, `building`, `tree`, `rack`), and for a building `data-name`. Its first path is `data-role="silhouette"`.
- Each room: a `<g data-room data-name data-rect>`.
- Each tag: a `<g data-role="tag" data-name data-at="x y z">` with a backing `<rect>` and a `<text data-role="name">`. The point sits inside the room it names at the plate top, or on the building's roof.
- The focal room or building carries `data-focal`.

## Anti-patterns

- Full-height walls that hide the rooms behind them.
- Boxes that overlap on the plate, or a box hanging past the plate edge.
- Painting by `x + y` alone, which draws long walls over the furniture in front of them.
- Tags tilted onto the floor plane, tags that overlap, or a numbered key under the figure.
- Accent on the focal room and on its furniture as well.
- Gradients, shadows, or glow on the plate or the boxes.

## Examples

- `assets/example-axonometric-plan.html`: office floor, minimal light
- `assets/example-axonometric-plan-campus.html`: campus site plan with roads, trees, and buildings tagged by phase
- `assets/example-axonometric-plan-coffee-shop.html`: a coffee shop with an entrance and queue posts, an espresso bar, round tables, a kitchen, and a restroom
- `assets/example-axonometric-plan-warehouse.html`: a fulfillment floor with dock doors, tall storage racks, a pick zone, packing stations, and shipping docks
- `assets/example-axonometric-plan-campus-animated.html`: the campus built phase by phase
- `assets/example-axonometric-plan-coffee-shop-animated.html`, `assets/example-axonometric-plan-warehouse-animated.html`: each floor revealed zone by zone in three phases
