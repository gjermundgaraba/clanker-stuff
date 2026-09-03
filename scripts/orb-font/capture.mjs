// Captures frames from the Thinking Orbs bundle (orbs.jakubantalik.com) as pure
// circle/line data. The bundle's scene functions are pure (size, time, opts) ->
// {dots, lines}; only the module-scope preload polyfill touches the DOM, so a
// tiny document stub is enough to import it in Node.
//
// Usage: node scripts/orb-font/capture.mjs
// Writes: scripts/orb-font/frames.json

globalThis.document = {
  createElement: () => ({ relList: { supports: () => true } }),
  querySelectorAll: () => [],
};
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
};

const { __scenes, __config, __stateModes, __scaleCounts, __scaleSizes } =
  await import("./thinking-orb-bundle.mjs");
const { customStates } = await import("./custom-scenes.mjs");

const SIZE = Number(process.argv[2] ?? 20); // 20 = one-cell variant, 64 = display variant
// Extra tuning for the one-cell set on top of the site's own 20px variant:
// fewer dots, each bigger, so the orb stays legible in a terminal cell.
const CELL_EXTRA = { count: 0.55, size: 1.6 };
const FPS = 30;
const CAPTURE_SECONDS = 8;
const MIN_LOOP_FRAMES = 36; // >= 1.2 s
const MAX_LOOP_FRAMES = 150; // <= 5 s, keeps glyph count sane

// Visual intensity is (1-white)*alpha on both themes (bundle fns Kd/Yd);
// used here only for loop detection. Frames keep raw white/alpha so the
// font builder and review tooling can reproduce the exact original paint.
const ink = (white, a) => (1 - Math.min(1, Math.max(0, white))) * (a ?? 1);

// Coarse grayscale raster of a frame, for loop-point detection only.
function rasterize(frame, grid = 24) {
  const cells = new Float64Array(grid * grid);
  const s = grid / SIZE;
  for (const [x, y, r, white, a] of frame.dots) {
    const gx = Math.min(grid - 1, Math.max(0, Math.floor(x * s)));
    const gy = Math.min(grid - 1, Math.max(0, Math.floor(y * s)));
    cells[gy * grid + gx] += r * r * ink(white, a);
  }
  for (const [x1, y1, x2, y2, w, white, a] of frame.lines) {
    const k = ink(white, a);
    const steps = 8;
    for (let i = 0; i <= steps; i++) {
      const x = x1 + ((x2 - x1) * i) / steps;
      const y = y1 + ((y2 - y1) * i) / steps;
      const gx = Math.min(grid - 1, Math.max(0, Math.floor(x * s)));
      const gy = Math.min(grid - 1, Math.max(0, Math.floor(y * s)));
      cells[gy * grid + gx] += (w * k) / steps;
    }
  }
  return cells;
}

const l1 = (a, b) => {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d;
};

const states = [...Object.keys(__stateModes), ...Object.keys(customStates)];
const out = { size: SIZE, fps: FPS, states: {} };

for (const state of states) {
  const custom = customStates[state];
  let { mode, speed, opts } = custom ? custom.config(SIZE) : __config(state, SIZE);
  if (!custom && SIZE === 20) {
    opts = __scaleSizes(__scaleCounts(opts, CELL_EXTRA.count), CELL_EXTRA.size);
  }
  const scene = custom ? custom.scene : __scenes[mode];
  const total = CAPTURE_SECONDS * FPS;
  const frames = [];
  for (let i = 0; i < total; i++) {
    const t = (i / FPS) * speed;
    const { dots, lines } = scene(SIZE, t, opts);
    frames.push({
      dots: dots.map((d) => [d.x, d.y, d.r, d.white, d.a ?? 1]),
      lines: lines.map((l) => [l.x1, l.y1, l.x2, l.y2, l.w, l.white, l.a ?? 1]),
    });
  }

  // Best wrap point: frame j most similar to frame 0.
  const first = rasterize(frames[0]);
  let best = MIN_LOOP_FRAMES;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (let j = MIN_LOOP_FRAMES; j <= Math.min(MAX_LOOP_FRAMES, total - 1); j++) {
    const d = l1(first, rasterize(frames[j]));
    if (d < bestDiff) {
      bestDiff = d;
      best = j;
    }
  }

  const loop = frames.slice(0, best);
  const dotCounts = loop.map((f) => f.dots.length);
  if (Math.min(...dotCounts) === 0) {
    throw new Error(`${state}: empty frame captured`);
  }
  out.states[state] = { mode, speed, frames: loop };
  console.log(
    `${state.padEnd(11)} mode=${mode.padEnd(7)} loop=${best}f (${(best / FPS).toFixed(2)}s) dots/frame~${Math.round(dotCounts.reduce((a, b) => a + b) / best)} lines=${loop[0].lines.length}`
  );
}

const { writeFileSync } = await import("node:fs");
const path = new URL(`./frames-${SIZE}.json`, import.meta.url).pathname;
writeFileSync(path, JSON.stringify(out));
console.log(`wrote ${path}`);

// Self-check: ASCII-render one frame so a human can eyeball the shape.
const check = out.states.breathing.frames[0];
const grid = 20;
const cells = new Float64Array(grid * grid);
for (const [x, y, r, white, a] of check.dots) {
  const gx = Math.min(grid - 1, Math.max(0, Math.round((x / SIZE) * (grid - 1))));
  const gy = Math.min(grid - 1, Math.max(0, Math.round((y / SIZE) * (grid - 1))));
  cells[gy * grid + gx] += r * ink(white, a);
}
const ramp = " .:*#";
let art = "";
for (let y = 0; y < grid; y++) {
  for (let x = 0; x < grid; x++) {
    const v = Math.min(1, cells[y * grid + x]);
    art += ramp[Math.min(ramp.length - 1, Math.floor(v * ramp.length))].repeat(2);
  }
  art += "\n";
}
console.log("breathing, frame 0:\n" + art);
