// Custom orb scenes that aren't on orbs.jakubantalik.com, written in the
// same visual grammar (depth-scaled dot radius + ink, z-sorted dot clouds)
// and the same pure contract: scene(size, t, opts) -> { dots, lines }.

// Smootherstep: zero velocity at both ends, so twists accelerate and
// settle instead of jerking from standstill to full speed.
const EASE = (x) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * t * (t * (t * 6 - 15) + 10);
};

function rotAxis([x, y, z], axis, ang) {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  if (axis === 0) return [x, y * c - z * s, y * s + z * c];
  if (axis === 1) return [x * c + z * s, y, -x * s + z * c];
  return [x * c - y * s, x * s + y * c, z];
}

// A dotted 3x3x3 Rubik's cube being "solved": 54 sticker dots, one layer
// twisting 90 degrees per move with cubic easing, three moves per loop
// (axis cycles x/y/z, slice cycles outer/outer/middle), plus a sine-based
// tumble whose frequencies divide the loop so the flipbook wraps seamlessly.
// Stickers are colorless, so each 90-degree twist maps the cloud onto itself.
export function cubeScene(size, t, o) {
  const c = size / 2;
  const h = size * (o.extent ?? 0.28); // cube half-extent
  const g = (2 * h) / 3; // cubie grid step
  const P = o.period ?? 1.5; // loop period, seconds (45 frames at 30fps)
  const mt = ((t % P) + P) % P;
  const seg = P / 3;
  const mi = Math.floor(mt / seg);
  const f = (mt - mi * seg) / seg;
  const twist = EASE(f / (o.twistFrac ?? 0.85));
  const ang = twist * (Math.PI / 2) * (mi % 2 ? -1 : 1);
  const axis = mi % 3;
  const slice = [1, -1, -1][mi] * g; // right, bottom, FRONT layer (z middle was invisible at this pose)

  const yaw = 0.42 + 0.16 * Math.sin((2 * Math.PI * mt) / P);
  const pitch = 0.34 + 0.1 * Math.sin((4 * Math.PI * mt) / P + 1.3);
  const sc = (size / 300) ** (o.rsPow ?? 0.6);
  const zSpan = h * Math.sqrt(3);

  const faces = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ];
  const dots = [];
  // Dotted wireframe so the silhouette reads as a cube: 8 corners plus two
  // interior dots per edge. Each point twists with whichever layer owns it.
  const framePts = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    framePts.push([sx * h, sy * h, sz * h]);
  }
  for (const axisE of [0, 1, 2]) {
    for (const sa of [-1, 1]) for (const sb of [-1, 1]) {
      for (const k of [-1 / 3, 1 / 3]) {
        const pt = [0, 0, 0];
        pt[axisE] = k * h;
        pt[(axisE + 1) % 3] = sa * h;
        pt[(axisE + 2) % 3] = sb * h;
        framePts.push(pt);
      }
    }
  }
  for (let p0 of framePts) {
    const cu = Math.max(-1, Math.min(1, Math.round(p0[axis] / g))) * g;
    if (Math.abs(cu - slice) < 1e-9) p0 = rotAxis(p0, axis, ang);
    let q = rotAxis(p0, 1, yaw);
    q = rotAxis(q, 0, pitch);
    const d = (-q[2] / zSpan + 1) / 2;
    dots.push({
      x: c + q[0],
      y: c - q[1],
      z: -q[2],
      r: ((o.rBase ?? 1.0) * 0.4 + (o.rDepth ?? 1.6) * 0.35 * d) * (o.rMul ?? 1) * sc,
      white: 0.58 - 0.28 * d,
      a: 0.25 + 0.5 * d,
    });
  }
  for (const n of faces) {
    const u = n[0] !== 0 ? [0, 1, 0] : [1, 0, 0];
    const v = [
      n[1] * u[2] - n[2] * u[1],
      n[2] * u[0] - n[0] * u[2],
      n[0] * u[1] - n[1] * u[0],
    ];
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        let p = [
          n[0] * h + u[0] * i * g + v[0] * j * g,
          n[1] * h + u[1] * i * g + v[1] * j * g,
          n[2] * h + u[2] * i * g + v[2] * j * g,
        ];
        // Which cubie layer does this sticker sit in along the move axis?
        const cu = Math.max(-1, Math.min(1, Math.round(p[axis] / g))) * g;
        const inSlice = Math.abs(cu - slice) < 1e-9;
        const active = inSlice && twist > 1e-4 && twist < 1;
        let nr = n;
        if (inSlice) {
          p = rotAxis(p, axis, ang);
          nr = rotAxis(n, axis, ang);
        }
        let q = rotAxis(p, 1, yaw);
        q = rotAxis(q, 0, pitch);
        let nq = rotAxis(nr, 1, yaw);
        nq = rotAxis(nq, 0, pitch);
        const facing = Math.max(0, -nq[2]); // -z is toward the viewer; far side occludes
        const d = (-q[2] / zSpan + 1) / 2;
        const pop = active ? Math.sin(Math.min(1, f / (o.twistFrac ?? 0.85)) * Math.PI) : 0;
        dots.push({
          x: c + q[0],
          y: c - q[1],
          z: -q[2],
          r: ((o.rBase ?? 1.0) + (o.rDepth ?? 1.6) * facing + (o.rActive ?? 0.9) * pop) * (o.rMul ?? 1) * sc,
          white: (o.inkFar ?? 0.42) - (o.inkSpan ?? 0.42) * facing - 0.12 * pop,
          a: 0.08 + 0.92 * facing ** 1.6,
        });
      }
    }
  }
  for (const dot of dots) dot.r = Math.max(o.rMin ?? 0.3, dot.r);
  dots.sort((a, b) => a.z - b.z);
  return { dots, lines: [] };
}

export const customStates = {
  cube: {
    scene: cubeScene,
    config: (size) => ({
      mode: "cube",
      speed: 1,
      opts: size >= 64 ? { rMul: 1.75 } : { rMul: 2.3 },
    }),
  },
};
