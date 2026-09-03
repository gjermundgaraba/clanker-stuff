// Stateful grid simulations rendered as Unicode half-blocks with synchronized
// terminal updates. Targeted at Ghostty; works in other modern terminals too.
//
// Run: node scripts/stateful-terminal-simulations.ts [physarum|dla|ink]

import assert from "node:assert/strict";

const CSI = "\x1b[";
const FPS = 20;
const NAMES = ["physarum", "dla", "ink"] as const;
type Name = (typeof NAMES)[number];
type Simulation = {
  readonly name: string;
  readonly detail: string;
  step: () => void;
  color: (index: number) => number;
  energy: () => number;
};

const randomFrom = (seed: number) => {
  let state = seed | 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
};
const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(high, value));
const wrap = (value: number, limit: number) =>
  ((Math.floor(value) % limit) + limit) % limit;
const fit = (text: string, width: number) =>
  [...text].slice(0, width).join("").padEnd(width);

const createPhysarum = (width: number, height: number): Simulation => {
  const random = randomFrom(0x51_1a_7e);
  let trail = new Float32Array(width * height);
  let blurred = new Float32Array(trail.length);
  const count = clamp(Math.floor(trail.length / 4), 240, 2_400);
  const x = new Float32Array(count);
  const y = new Float32Array(count);
  const angle = new Float32Array(count);
  for (let index = 0; index < count; index++) {
    const radius = random() * Math.min(width, height) * 0.22;
    const theta = random() * Math.PI * 2;
    x[index] = width / 2 + Math.cos(theta) * radius;
    y[index] = height / 2 + Math.sin(theta) * radius;
    angle[index] = theta + (random() - 0.5) * 1.5;
  }
  const sense = (px: number, py: number, heading: number) => {
    const sx = wrap(px + Math.cos(heading) * 4, width);
    const sy = wrap(py + Math.sin(heading) * 4, height);
    return trail[sy * width + sx]!;
  };
  return {
    name: "Physarum slime mold",
    detail: `${count} agents sense, steer, deposit, diffuse`,
    step: () => {
      for (let row = 0; row < height; row++) {
        for (let column = 0; column < width; column++) {
          let sum = 0;
          for (let oy = -1; oy <= 1; oy++)
            for (let ox = -1; ox <= 1; ox++)
              sum +=
                trail[
                  wrap(row + oy, height) * width + wrap(column + ox, width)
                ]!;
          blurred[row * width + column] = Math.min(1, (sum / 9) * 0.975);
        }
      }
      [trail, blurred] = [blurred, trail];
      for (let index = 0; index < count; index++) {
        const heading = angle[index]!;
        const left = sense(x[index]!, y[index]!, heading - 0.62);
        const front = sense(x[index]!, y[index]!, heading);
        const right = sense(x[index]!, y[index]!, heading + 0.62);
        let turn = 0;
        if (front < left || front < right)
          turn = left > right ? -0.42 : right > left ? 0.42 : random() - 0.5;
        angle[index] = heading + turn + (random() - 0.5) * 0.12;
        x[index] = (x[index]! + Math.cos(angle[index]!) + width) % width;
        y[index] = (y[index]! + Math.sin(angle[index]!) + height) % height;
        const cell = wrap(y[index]!, height) * width + wrap(x[index]!, width);
        trail[cell] = Math.min(1, trail[cell]! + 0.42);
      }
    },
    color: (index) => {
      const level = clamp(Math.floor(Math.sqrt(trail[index]!) * 6), 0, 5);
      return [16, 17, 53, 89, 161, 227][level]!;
    },
    energy: () => trail.reduce((sum, value) => sum + value, 0),
  };
};

const createDla = (width: number, height: number): Simulation => {
  const random = randomFrom(0xd1_a5_eed);
  const solid = new Uint8Array(width * height);
  const flash = new Float32Array(solid.length);
  const count = clamp(Math.floor(solid.length / 30), 70, 360);
  const x = new Float32Array(count);
  const y = new Float32Array(count);
  const centerX = Math.floor(width / 2);
  const centerY = Math.floor(height / 2);
  let radius = 1;
  solid[centerY * width + centerX] = 1;
  const launch = (index: number) => {
    const theta = random() * Math.PI * 2;
    const distance = Math.min(radius + 3, Math.min(width, height) * 0.44);
    x[index] = centerX + Math.cos(theta) * distance;
    y[index] = centerY + Math.sin(theta) * distance;
  };
  for (let index = 0; index < count; index++) launch(index);
  const touchesCrystal = (px: number, py: number) => {
    const ix = Math.round(px);
    const iy = Math.round(py);
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        if (ox === 0 && oy === 0) continue;
        const nx = ix + ox;
        const ny = iy + oy;
        if (
          nx >= 0 &&
          nx < width &&
          ny >= 0 &&
          ny < height &&
          solid[ny * width + nx]
        )
          return true;
      }
    }
    return false;
  };
  return {
    name: "Diffusion-limited aggregation",
    detail: `${count} Brownian walkers crystallize on contact`,
    step: () => {
      for (let index = 0; index < flash.length; index++) flash[index] *= 0.9;
      for (let index = 0; index < count; index++) {
        for (let walk = 0; walk < 10; walk++) {
          x[index] += Math.floor(random() * 3) - 1;
          y[index] += Math.floor(random() * 3) - 1;
          const distance = Math.hypot(x[index]! - centerX, y[index]! - centerY);
          if (
            x[index]! < 1 ||
            x[index]! >= width - 1 ||
            y[index]! < 1 ||
            y[index]! >= height - 1 ||
            distance > radius + 9
          ) {
            launch(index);
          } else if (touchesCrystal(x[index]!, y[index]!)) {
            const ix = Math.round(x[index]!);
            const iy = Math.round(y[index]!);
            const cell = iy * width + ix;
            solid[cell] = 1;
            flash[cell] = 1;
            radius = Math.max(radius, Math.hypot(ix - centerX, iy - centerY));
            launch(index);
            break;
          }
        }
      }
    },
    color: (index) => (solid[index] ? (flash[index]! > 0.3 ? 231 : 51) : 16),
    energy: () => solid.reduce((sum, value) => sum + value, 0),
  };
};

const createInk = (width: number, height: number): Simulation => {
  let cyan = new Float32Array(width * height);
  let magenta = new Float32Array(cyan.length);
  let nextCyan = new Float32Array(cyan.length);
  let nextMagenta = new Float32Array(cyan.length);
  let time = 0;
  const sample = (field: Float32Array, px: number, py: number) => {
    const safeX = clamp(px, 0, width - 1);
    const safeY = clamp(py, 0, height - 1);
    const x0 = Math.floor(safeX);
    const y0 = Math.floor(safeY);
    const x1 = Math.min(width - 1, x0 + 1);
    const y1 = Math.min(height - 1, y0 + 1);
    const fx = safeX - x0;
    const fy = safeY - y0;
    return (
      (field[y0 * width + x0]! * (1 - fx) + field[y0 * width + x1]! * fx) *
        (1 - fy) +
      (field[y1 * width + x0]! * (1 - fx) + field[y1 * width + x1]! * fx) * fy
    );
  };
  return {
    name: "Ink in water",
    detail: "semi-Lagrangian advection through moving vortices",
    step: () => {
      time += 0.05;
      const cx = width * (0.5 + Math.sin(time * 0.8) * 0.16);
      const cy = height * (0.5 + Math.cos(time * 0.55) * 0.1);
      const spread = Math.max(30, width * height * 0.045);
      for (let row = 0; row < height; row++) {
        for (let column = 0; column < width; column++) {
          const dx = column - cx;
          const dy = row - cy;
          const force = Math.exp(-(dx * dx + dy * dy) / spread);
          const velocityX =
            Math.sin(row * 0.11 + time) * 0.38 - dy * force * 0.07;
          const velocityY = 0.12 + dx * force * 0.07;
          const index = row * width + column;
          nextCyan[index] =
            sample(cyan, column - velocityX, row - velocityY) * 0.994;
          nextMagenta[index] =
            sample(magenta, column - velocityX, row - velocityY) * 0.994;
        }
      }
      [cyan, nextCyan] = [nextCyan, cyan];
      [magenta, nextMagenta] = [nextMagenta, magenta];
      for (let offset = -3; offset <= 3; offset++) {
        const row = clamp(2 + Math.abs(offset), 0, height - 1);
        const first =
          row * width +
          clamp(
            Math.round(width * 0.34 + Math.sin(time * 1.7) * 5 + offset),
            0,
            width - 1
          );
        const second =
          row * width +
          clamp(
            Math.round(width * 0.66 + Math.cos(time * 1.3) * 5 + offset),
            0,
            width - 1
          );
        cyan[first] = Math.min(1, cyan[first]! + 0.45);
        magenta[second] = Math.min(1, magenta[second]! + 0.45);
      }
    },
    color: (index) => {
      const c = clamp(Math.round(Math.sqrt(cyan[index]!) * 5), 0, 5);
      const m = clamp(Math.round(Math.sqrt(magenta[index]!) * 5), 0, 5);
      return c || m
        ? 16 + m * 36 + Math.min(5, Math.round((c + m) / 3)) * 6 + c
        : 16;
    },
    energy: () =>
      cyan.reduce((sum, value, index) => sum + value + magenta[index]!, 0),
  };
};

const createSimulation = (name: Name, width: number, height: number) =>
  name === "physarum"
    ? createPhysarum(width, height)
    : name === "dla"
      ? createDla(width, height)
      : createInk(width, height);

const render = (simulation: Simulation, width: number, height: number) => {
  const lines: string[] = [];
  for (let row = 0; row < height; row += 2) {
    const parts: string[] = [];
    let previous = "";
    for (let column = 0; column < width; column++) {
      const foreground = simulation.color(row * width + column);
      const background = simulation.color(
        Math.min(height - 1, row + 1) * width + column
      );
      const colors = `${foreground};48;5;${background}`;
      if (colors !== previous) parts.push(`${CSI}38;5;${colors}m`);
      parts.push("▀");
      previous = colors;
    }
    lines.push(`${parts.join("")}${CSI}0m`);
  }
  return lines.join("\n");
};

if (process.argv.includes("--list")) {
  console.log("physarum  agent-based slime mold trail network");
  console.log("dla       diffusion-limited crystal growth");
  console.log("ink       advected cyan/magenta ink plumes");
  process.exit(0);
}

if (process.argv.includes("--check")) {
  for (const name of NAMES) {
    const simulation = createSimulation(name, 48, 30);
    const before = simulation.energy();
    for (let step = 0; step < 40; step++) simulation.step();
    assert.ok(simulation.energy() > before, `${name} must accumulate state`);
    const frame = render(simulation, 48, 30);
    assert.equal(frame.split("\n").length, 15);
    assert.match(frame, /\x1b\[38;5;/);
    assert.ok(
      new Set([...frame.matchAll(/38;5;(\d+)/g)].map((match) => match[1]))
        .size > 1
    );
  }
  console.log(
    "Stateful simulation self-check passed: Physarum, DLA, and ink evolve."
  );
  process.exit(0);
}

const output = process.stdout;
const input = process.stdin;
if (!output.isTTY || !input.isTTY || process.env.TERM === "dumb") {
  console.log(
    "Run in an interactive terminal (Ghostty recommended), or use --list."
  );
  process.exit(0);
}
const terminalIsTooSmall = () =>
  (output.columns ?? 80) < 20 || (output.rows ?? 24) < 6;
if (terminalIsTooSmall()) {
  console.error("Stateful simulations require at least 20x6 cells.");
  process.exit(1);
}

const requested = process.argv.find((argument): argument is Name =>
  NAMES.includes(argument as Name)
);
let selected = requested ? NAMES.indexOf(requested) : 0;
let cycling = !requested;
let sceneStarted = performance.now();
let width = 0;
let height = 0;
let simulation: Simulation;
let stopped = false;

const reset = () => {
  width = Math.min(output.columns ?? 80, 120);
  height = Math.min(((output.rows ?? 24) - 2) * 2, 80);
  simulation = createSimulation(NAMES[selected]!, width, height);
  sceneStarted = performance.now();
};
const select = (offset: number) => {
  selected = (selected + offset + NAMES.length) % NAMES.length;
  reset();
};
const stop = (code = 0, error?: unknown) => {
  if (stopped) return;
  stopped = true;
  clearInterval(timer);
  input.off("data", onInput);
  input.setRawMode(false);
  input.pause();
  output.write(`${CSI}?2026l${CSI}0m${CSI}?7h${CSI}?25h${CSI}?1049l`);
  if (error) console.error(error);
  process.exitCode = code;
};
const draw = () => {
  try {
    if (terminalIsTooSmall()) {
      stop();
      return;
    }
    const nextWidth = Math.min(output.columns ?? 80, 120);
    const nextHeight = Math.min(((output.rows ?? 24) - 2) * 2, 80);
    if (nextWidth !== width || nextHeight !== height) reset();
    if (cycling && performance.now() - sceneStarted > 14_000) select(1);
    simulation.step();
    const header = fit(`${simulation.name} · ${simulation.detail}`, width);
    const footer = fit(
      `←/→ or 1–3 select · r reset · c cycle ${cycling ? "on" : "off"} · q quit`,
      width
    );
    output.write(
      `${CSI}?2026h${CSI}H${CSI}1m${header}${CSI}0m\n${render(simulation, width, height)}\n${CSI}2m${footer}${CSI}0m${CSI}J${CSI}?2026l`
    );
  } catch (error) {
    stop(1, error);
  }
};
const onInput = (chunk: Buffer) => {
  const key = chunk.toString();
  if (key === "q" || key === "\x1b" || key === "\x03") stop();
  else if (key === "\x1b[C" || key === "l") select(1);
  else if (key === "\x1b[D" || key === "h") select(-1);
  else if (/^[123]$/.test(key)) {
    selected = Number(key) - 1;
    reset();
  } else if (key === "r") reset();
  else if (key === "c") cycling = !cycling;
};

input.setRawMode(true);
input.resume();
input.on("data", onInput);
process.once("SIGTERM", () => stop(143));
process.once("uncaughtException", (error) => stop(1, error));
output.write(`${CSI}?1049h${CSI}?25l${CSI}?7l`);
reset();
const timer = setInterval(draw, 1000 / FPS);
draw();
