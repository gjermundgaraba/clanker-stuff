interface Polyhedron {
  vertices: number[][];
  faces: number[][];
  radius: number;
  rest: number[];
  elevation: number;
}
interface Geometry {
  shape: string;
  vertices: number[][];
  lines: number[][];
  linePlanes: number[][];
  normals: number[][];
  rings: { normal: number[]; axis: number[]; rate: number; radius: number }[];
  radius: number;
  strokeWidth: number;
  rest: number[];
  elevation: number;
  planeDistance: number;
}
// Build-time reconstruction; provenance and fidelity limits: ../docs/font.md.
const TAU = Math.PI * 2;
const CAMERA = 2.6;
const clamp = (x: number) => Math.max(0, Math.min(1, x));
const add = (a: number[], b: number[]) => a.map((v, i) => v + b[i]);
const mul = (a: number[], k: number) => a.map((v) => v * k);
const dot = (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const cross = (a: number[], b: number[]) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: number[]) => mul(a, 1 / Math.hypot(...a));
const axisQ = (axis: number[], angle: number) => [
  Math.cos(angle / 2),
  ...mul(axis, Math.sin(angle / 2)),
];
function qm(a: number[], b: number[]) {
  return norm([
    a[0] * b[0] - dot(a.slice(1), b.slice(1)),
    ...add(add(mul(b.slice(1), a[0]), mul(a.slice(1), b[0])), cross(a.slice(1), b.slice(1))),
  ]);
}
function rotate(q: number[], p: number[]) {
  const t = mul(cross(q.slice(1), p), 2);
  return add(p, add(mul(t, q[0]), cross(q.slice(1), t)));
}
function fromTo(a: number[], b: number[]) {
  const d = Math.max(-1, Math.min(1, dot(a, b))),
    c = cross(a, b),
    length = Math.hypot(...c);
  if (length < 1e-9)
    return d > 0
      ? [1, 0, 0, 0]
      : axisQ(norm(cross(a, Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), Math.PI);
  return axisQ(mul(c, 1 / length), Math.atan2(length, d));
}
function upright(up: number[], frontInput: number[]) {
  const front = norm(add(frontInput, mul(up, -dot(frontInput, up))));
  const q = fromTo(up, [0, -1, 0]),
    f = rotate(q, front);
  return qm(axisQ([0, 1, 0], -Math.atan2(f[0], f[2])), q);
}
function randomWords(seed: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193) >>> 0;
  if (!h) h = 0x9e3779b9;
  return Array.from({ length: 13 }, () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return h >>> 0;
  });
}
const unit = 1 / Math.sqrt(3);
const POLYHEDRA = {
  cube: {
    vertices: Array.from({ length: 8 }, (_, i) => [
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
    vertices: [
      [1, 1, 1],
      [1, -1, -1],
      [-1, 1, -1],
      [-1, -1, 1],
    ].map((v) => mul(v, unit)),
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
    linePlanes: [],
    normals: [],
    rings: [],
    radius: 9.5,
    strokeWidth: 1.2,
    rest: [1, 0, 0, 0],
    elevation: 0,
    planeDistance: 0,
  };
  if (shape === "orb") {
    const r = randomWords(seed).map((v) => (v % 1000) / 999),
      base = r[0] * TAU;
    g.rings.push({ normal: [0, 0, 1], axis: [0, 1, 0], rate: 0, radius: 1 });
    for (let i = 0; i < 3; i++) {
      const k = 1 + i * 4;
      // Native build 308: 55–85°, NOT the cached web renderer's 55–80°.
      const theta = (55 * Math.PI) / 180 + r[k] * ((85 * Math.PI) / 180 - (55 * Math.PI) / 180);
      const phi = base + (i / 3) * TAU + ((r[k + 1] * 2 - 1) * 15 * Math.PI) / 180;
      const n = [Math.sin(theta) * Math.cos(phi), Math.sin(theta) * Math.sin(phi), Math.cos(theta)];
      const u = norm(cross(n, [0, 1, 0])),
        v = cross(n, u),
        roll = ((r[k + 2] * 2 - 1) * Math.PI) / 4;
      g.rings.push({
        normal: n,
        axis: add(mul(u, Math.cos(roll)), mul(v, Math.sin(roll))),
        rate: [1, 2, 1][i] * (r[k + 3] < 0.5 ? 1 : -1),
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
        g.lines.push(Array.from({ length: 6 }, (_, k) => offset + ((j + k) % 20)));
        g.linePlanes.push([i, i]);
      }
    });
  } else {
    const poly = POLYHEDRA[shape];
    g.vertices = poly.vertices.map((v) => [...v]);
    g.radius = poly.radius;
    g.rest = [...poly.rest];
    g.elevation = poly.elevation;
    g.normals = poly.faces.map((face) =>
      norm(face.reduce((sum, i) => add(sum, mul(g.vertices[i], 1 / face.length)), [0, 0, 0])),
    );
    g.planeDistance = dot(g.normals[0], g.vertices[poly.faces[0][0]]);
    const edges = new Map<string, { edge: number[]; faces: number[] }>();
    poly.faces.forEach((face, f) =>
      face.forEach((a, j) => {
        const b = face[(j + 1) % face.length],
          edge = [Math.min(a, b), Math.max(a, b)],
          key = edge.join("-");
        const existing = edges.get(key);
        if (existing) existing.faces.push(f);
        else edges.set(key, { edge, faces: [f] });
      }),
    );
    for (const { edge, faces } of edges.values()) {
      if (faces.length !== 2) throw new Error("Non-manifold edge");
      g.lines.push(edge);
      g.linePlanes.push(faces);
    }
  }
  g.radius *= 1.15;
  return g;
}
function project(g: Geometry, yaw = 0, restWeight = 1) {
  let q = qm(axisQ([0, 1, 0], yaw), g.rest);
  if (g.elevation) q = qm(axisQ([-1, 0, 0], g.elevation), q);
  const ringQs = g.rings.map((r) => (r.rate === 0 ? q : qm(q, axisQ(r.axis, yaw * r.rate))));
  const vertices = g.vertices.map((v, i) => {
    const p = rotate(ringQs[Math.floor(i / 20)] || q, v),
      scale = (g.radius * CAMERA) / (CAMERA - p[2]);
    return [12 + p[0] * scale, 12 + p[1] * scale, p[2]];
  });
  const planeZ = g.normals.map((n, i) => rotate(ringQs[i] || q, n)[2]);
  const threshold = Math.cos(Math.PI / 6);
  return g.lines
    .map((indices, id) => {
      const points = indices.map((i) => vertices[i]);
      const depth = points.reduce((sum, p) => sum + p[2] / points.length, 0);
      const [a, b] = g.linePlanes[id];
      const outline =
        g.shape === "orb"
          ? clamp((Math.abs(planeZ[a]) - threshold) / (1 - threshold))
          : Number(planeZ[a] * CAMERA > g.planeDistance !== planeZ[b] * CAMERA > g.planeDistance);
      const base = 0.16 + 0.84 * ((depth + 1) / 2) ** 1.5;
      return { id, points, depth, outline, opacity: base + restWeight * outline * (1 - base) };
    })
    .sort((a, b) => a.depth - b.depth);
}
export { TAU, SHAPES, geometry, project };
