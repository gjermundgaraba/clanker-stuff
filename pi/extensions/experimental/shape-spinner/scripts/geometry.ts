type Vector3 = [number, number, number];

type Quaternion = [number, number, number, number];

type Face = [number, number, number, ...number[]];

interface Polyhedron {
  vertices: Vector3[];
  faces: [Face, ...Face[]];
  radius: number;
  rest: Quaternion;
  elevation: number;
}

interface Geometry {
  shape: string;
  vertices: Vector3[];
  lines: { indices: [number, ...number[]]; planes: [number, number] }[];
  normals: Vector3[];
  rings: { normal: Vector3; axis: Vector3; rate: number; radius: number }[];
  radius: number;
  strokeWidth: number;
  rest: Quaternion;
  elevation: number;
  planeDistance: number;
}

// Build-time reconstruction; provenance and fidelity limits: ../docs/font.md.
const TAU = Math.PI * 2;

const CAMERA = 2.6;

const clamp = (x: number) => Math.max(0, Math.min(1, x));

const add = (a: Vector3, b: Vector3): Vector3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

const mul = (a: Vector3, k: number): Vector3 => [a[0] * k, a[1] * k, a[2] * k];

const dot = (a: Vector3, b: Vector3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const cross = (a: Vector3, b: Vector3): Vector3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

const norm = (a: Vector3) => mul(a, 1 / Math.hypot(...a));

const axisQ = (axis: Vector3, angle: number): Quaternion => [
  Math.cos(angle / 2),
  ...mul(axis, Math.sin(angle / 2)),
];

function qm([aw, ...av]: Quaternion, [bw, ...bv]: Quaternion): Quaternion {
  const scalar = aw * bw - dot(av, bv);
  const vector = add(add(mul(bv, aw), mul(av, bw)), cross(av, bv));
  const scale = 1 / Math.hypot(scalar, ...vector);

  return [scalar * scale, ...mul(vector, scale)];
}

function rotate([w, ...v]: Quaternion, p: Vector3) {
  const t = mul(cross(v, p), 2);

  return add(p, add(mul(t, w), cross(v, t)));
}

function fromTo(a: Vector3, b: Vector3): Quaternion {
  const d = Math.max(-1, Math.min(1, dot(a, b))),
    c = cross(a, b),
    length = Math.hypot(...c);

  if (length < 1e-9)
    return d > 0
      ? [1, 0, 0, 0]
      : axisQ(norm(cross(a, Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), Math.PI);

  return axisQ(mul(c, 1 / length), Math.atan2(length, d));
}

function upright(up: Vector3, frontInput: Vector3) {
  const front = norm(add(frontInput, mul(up, -dot(frontInput, up))));

  const q = fromTo(up, [0, -1, 0]),
    f = rotate(q, front);

  return qm(axisQ([0, 1, 0], -Math.atan2(f[0], f[2])), q);
}

function randomUnit(seed: string) {
  let h = 0x811c9dc5;

  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193) >>> 0;

  if (!h) h = 0x9e3779b9;

  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;

    return ((h >>> 0) % 1000) / 999;
  };
}

const unit = 1 / Math.sqrt(3);

const POLYHEDRA = {
  cube: {
    vertices: Array.from({ length: 8 }, (_, i): Vector3 => [
      i & 1 ? unit : -unit,
      i & 2 ? unit : -unit,
      i & 4 ? unit : -unit,
    ]),
    faces: [
      [0, 1, 3, 2],
      [4, 5, 7, 6],
      [0, 1, 5, 4],
      [2, 3, 7, 6],
      [0, 2, 6, 4],
      [1, 3, 7, 5],
    ],
    radius: 10.6,
    rest: upright(norm([1, 1, 1]), [1, -1, -1]),
    elevation: 0,
  },
  octahedron: {
    vertices: [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ],
    faces: [
      [0, 2, 4],
      [0, 2, 5],
      [0, 3, 4],
      [0, 3, 5],
      [1, 2, 4],
      [1, 2, 5],
      [1, 3, 4],
      [1, 3, 5],
    ],
    radius: 10.6,
    rest: upright([0, 1, 0], [0, 0, 1]),
    elevation: (14 * Math.PI) / 180,
  },
  tetrahedron: {
    vertices: (
      [
        [1, 1, 1],
        [1, -1, -1],
        [-1, 1, -1],
        [-1, -1, 1],
      ] satisfies Vector3[]
    ).map((v) => mul(v, unit)),
    faces: [
      [0, 1, 2],
      [0, 1, 3],
      [0, 2, 3],
      [1, 2, 3],
    ],
    radius: 11,
    rest: upright(norm([1, 1, 1]), [-1, 1, 1]),
    elevation: (14 * Math.PI) / 180,
  },
} satisfies Record<"cube" | "octahedron" | "tetrahedron", Polyhedron>;

const SHAPES = ["orb", "cube", "octahedron", "tetrahedron"];

function geometry(seed: string, shape = "orb") {
  if (shape !== "orb" && shape !== "cube" && shape !== "octahedron" && shape !== "tetrahedron") {
    throw new Error("Unknown shape: " + shape);
  }

  const g: Geometry = {
    shape,
    vertices: [],
    lines: [],
    normals: [],
    rings: [],
    radius: 9.5,
    strokeWidth: 1.2,
    rest: [1, 0, 0, 0],
    elevation: 0,
    planeDistance: 0,
  };

  if (shape === "orb") {
    const random = randomUnit(seed);
    const base = random() * TAU;

    g.rings.push({ normal: [0, 0, 1], axis: [0, 1, 0], rate: 0, radius: 1 });

    for (const [i, rate] of [1, 2, 1].entries()) {
      // Native build 308: 55–85°, NOT the cached web renderer's 55–80°.
      const theta = (55 * Math.PI) / 180 + random() * ((85 * Math.PI) / 180 - (55 * Math.PI) / 180);
      const phi = base + (i / 3) * TAU + ((random() * 2 - 1) * 15 * Math.PI) / 180;

      const n: Vector3 = [
        Math.sin(theta) * Math.cos(phi),
        Math.sin(theta) * Math.sin(phi),
        Math.cos(theta),
      ];

      const u = norm(cross(n, [0, 1, 0])),
        v = cross(n, u),
        roll = ((random() * 2 - 1) * Math.PI) / 4;

      g.rings.push({
        normal: n,
        axis: add(mul(u, Math.cos(roll)), mul(v, Math.sin(roll))),
        rate: rate * (random() < 0.5 ? 1 : -1),
        radius: 0.92,
      });
    }

    g.rings.forEach((ring, i) => {
      g.normals.push(ring.normal);

      const v = cross(ring.normal, ring.axis),
        offset = g.vertices.length;

      for (let j = 0; j < 20; j++) {
        const a = (j / 20) * TAU;
        g.vertices.push(mul(add(mul(ring.axis, Math.cos(a)), mul(v, Math.sin(a))), ring.radius));
      }

      for (let j = 0; j < 20; j += 5) {
        g.lines.push({
          indices: [
            offset + j,
            ...Array.from({ length: 5 }, (_, k) => offset + ((j + k + 1) % 20)),
          ],
          planes: [i, i],
        });
      }
    });
  } else {
    const poly = POLYHEDRA[shape];
    g.vertices = poly.vertices.map((v): Vector3 => [...v]);
    g.radius = poly.radius;
    g.rest = [...poly.rest];
    g.elevation = poly.elevation;
    g.normals = poly.faces.map((face) =>
      norm(
        face.reduce<Vector3>(
          (sum, i) => {
            // Faces refer only to vertices in the fixed, private POLYHEDRA tables.
            return add(sum, mul(g.vertices[i]!, 1 / face.length));
          },
          [0, 0, 0],
        ),
      ),
    );
    // The nonempty face table defines each normal and references only its own vertices.
    g.planeDistance = dot(g.normals[0]!, g.vertices[poly.faces[0][0]]!);
    const edges = new Map<string, { edge: [number, number]; faces: number[] }>();
    poly.faces.forEach((face, f) =>
      face.forEach((a, j) => {
        // Iteration implies a nonempty face; modulo wraps to another member of that same face.
        const b = face[(j + 1) % face.length]!;
        const edge: [number, number] = [Math.min(a, b), Math.max(a, b)];
        const key = edge.join("-");

        const existing = edges.get(key);

        if (existing) existing.faces.push(f);
        else edges.set(key, { edge, faces: [f] });
      }),
    );

    for (const { edge, faces } of edges.values()) {
      const [first, second, ...extra] = faces;

      if (first === undefined || second === undefined || extra.length)
        throw new Error("Non-manifold edge");
      g.lines.push({ indices: edge, planes: [first, second] });
    }
  }

  g.radius *= 1.15;

  return g;
}

function project(g: Geometry, yaw = 0, restWeight = 1) {
  let q = qm(axisQ([0, 1, 0], yaw), g.rest);

  if (g.elevation) q = qm(axisQ([-1, 0, 0], g.elevation), q);
  const ringQs = g.rings.map((r) => (r.rate === 0 ? q : qm(q, axisQ(r.axis, yaw * r.rate))));

  const vertices = g.vertices.map((v, i): Vector3 => {
    const p = rotate(ringQs[Math.floor(i / 20)] || q, v),
      scale = (g.radius * CAMERA) / (CAMERA - p[2]);

    return [12 + p[0] * scale, 12 + p[1] * scale, p[2]];
  });

  const planeZ = g.normals.map((n, i) => rotate(ringQs[i] || q, n)[2]);
  const threshold = Math.cos(Math.PI / 6);

  return g.lines
    .map(({ indices: [first, ...rest], planes: [a, b] }, id) => {
      // geometry owns these indices; projection preserves both vertex and normal ordering.
      const points: [Vector3, ...Vector3[]] = [vertices[first]!, ...rest.map((i) => vertices[i]!)];
      const depth = points.reduce((sum, p) => sum + p[2] / points.length, 0);
      const za = planeZ[a]!;
      const zb = planeZ[b]!;

      const outline =
        g.shape === "orb"
          ? clamp((Math.abs(za) - threshold) / (1 - threshold))
          : Number(za * CAMERA > g.planeDistance !== zb * CAMERA > g.planeDistance);

      const base = 0.16 + 0.84 * ((depth + 1) / 2) ** 1.5;

      return { id, points, depth, outline, opacity: base + restWeight * outline * (1 - base) };
    })
    .sort((a, b) => a.depth - b.depth);
}

export { TAU, SHAPES, geometry, project };
