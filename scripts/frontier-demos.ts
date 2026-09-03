import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { basename, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const CSI = "\x1b[";
const ESC = "\x1b";
const DARK = [4, 5, 14] as const;
const WHITE = [220, 232, 255] as const;
const CYAN = [74, 240, 220] as const;
const MAGENTA = [255, 72, 184] as const;
const GOLD = [255, 202, 82] as const;
const BRAILLE_BITS = [1, 8, 2, 16, 4, 32, 64, 128] as const;

export const DEMO_NAMES = [
  "glyph-forge",
  "kinetic-matter",
  "sound-reactor",
  "terminal-scene-graph",
  "vfx-anthology",
] as const;
export type DemoName = (typeof DEMO_NAMES)[number];

type Color = readonly [number, number, number];
type Vec3 = [number, number, number];
type Cell = { glyph: string; fg: Color; bg: Color | null; bold: boolean };
type DemoOptions = {
  seconds: number;
  fps: number;
  audio?: string;
  mic: boolean;
  nativeImages: boolean;
  nativeRectangles: boolean;
};
type InputState = {
  keys: Set<string>;
  mouse: { x: number; y: number; down: boolean };
};
type Scene = {
  tick?(dt: number, time: number, input: InputState): void;
  render(canvas: Canvas, time: number, input: InputState): void;
  nativeFrame?(time: number): string;
  dispose?(): string | void;
};

const clamp = (value: number, low = 0, high = 1) =>
  Math.max(low, Math.min(high, value));
const hash = (value: number) => {
  const result = Math.sin(value * 12.9898) * 43_758.5453;
  return result - Math.floor(result);
};
const mix = (a: Color, b: Color, amount: number): Color => [
  Math.round(a[0] + (b[0] - a[0]) * amount),
  Math.round(a[1] + (b[1] - a[1]) * amount),
  Math.round(a[2] + (b[2] - a[2]) * amount),
];
const scale = (color: Color, amount: number): Color => [
  Math.round(color[0] * amount),
  Math.round(color[1] * amount),
  Math.round(color[2] * amount),
];
const hsv = (hue: number, saturation = 1, value = 1): Color => {
  const h = ((hue % 1) + 1) % 1;
  const index = Math.floor(h * 6);
  const fraction = h * 6 - index;
  const p = value * (1 - saturation);
  const q = value * (1 - fraction * saturation);
  const t = value * (1 - (1 - fraction) * saturation);
  const [r, g, b] = (
    [
      [value, t, p],
      [q, value, p],
      [p, value, t],
      [p, q, value],
      [t, p, value],
      [value, p, q],
    ] as const
  )[index % 6] ?? [value, value, value];
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
};
const colorDistance = (a: Color, b: Color) =>
  (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const luminance = (color: Color) =>
  color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722;
const average = (colors: readonly Color[], fallback: Color): Color => {
  if (colors.length === 0) return fallback;
  const sum = colors.reduce(
    (total, color) => [
      total[0] + color[0],
      total[1] + color[1],
      total[2] + color[2],
    ],
    [0, 0, 0]
  );
  return [
    Math.round(sum[0] / colors.length),
    Math.round(sum[1] / colors.length),
    Math.round(sum[2] / colors.length),
  ];
};

class Canvas {
  readonly cells: Cell[];

  constructor(
    readonly width: number,
    readonly height: number
  ) {
    this.cells = Array.from({ length: width * height }, () => ({
      glyph: " ",
      fg: WHITE,
      bg: DARK,
      bold: false,
    }));
  }

  clear(bg: Color | null = DARK) {
    for (const cell of this.cells) {
      cell.glyph = " ";
      cell.fg = WHITE;
      cell.bg = bg;
      cell.bold = false;
    }
  }

  put(
    x: number,
    y: number,
    glyph: string,
    fg: Color = WHITE,
    bg: Color | null = DARK,
    bold = false
  ) {
    const column = Math.round(x);
    const row = Math.round(y);
    if (column < 0 || row < 0 || column >= this.width || row >= this.height)
      return;
    this.cells[row * this.width + column] = { glyph, fg, bg, bold };
  }

  text(
    x: number,
    y: number,
    text: string,
    fg: Color = WHITE,
    bg: Color | null = DARK,
    bold = false
  ) {
    let column = Math.round(x);
    for (const glyph of text) {
      this.put(column, y, glyph, fg, bg, bold);
      column += 1;
    }
  }

  center(
    y: number,
    text: string,
    fg: Color = WHITE,
    bg: Color | null = DARK,
    bold = false
  ) {
    this.text(
      Math.floor((this.width - [...text].length) / 2),
      y,
      text,
      fg,
      bg,
      bold
    );
  }

  line(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    glyph: string,
    fg: Color,
    bg: Color | null = DARK
  ) {
    let x = Math.round(x0);
    let y = Math.round(y0);
    const targetX = Math.round(x1);
    const targetY = Math.round(y1);
    const dx = Math.abs(targetX - x);
    const sx = x < targetX ? 1 : -1;
    const dy = -Math.abs(targetY - y);
    const sy = y < targetY ? 1 : -1;
    let error = dx + dy;
    for (;;) {
      this.put(x, y, glyph, fg, bg);
      if (x === targetX && y === targetY) break;
      const twice = error * 2;
      if (twice >= dy) {
        error += dy;
        x += sx;
      }
      if (twice <= dx) {
        error += dx;
        y += sy;
      }
    }
  }

  ellipse(
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    glyph: string,
    fg: Color,
    bg: Color | null = DARK,
    steps = 80
  ) {
    let previous = [cx + rx, cy] as const;
    for (let step = 1; step <= steps; step++) {
      const angle = (step / steps) * Math.PI * 2;
      const point = [
        cx + Math.cos(angle) * rx,
        cy + Math.sin(angle) * ry,
      ] as const;
      this.line(previous[0], previous[1], point[0], point[1], glyph, fg, bg);
      previous = point;
    }
  }

  box(
    x: number,
    y: number,
    width: number,
    height: number,
    fg: Color,
    bg: Color | null = DARK
  ) {
    this.line(x + 1, y, x + width - 2, y, "─", fg, bg);
    this.line(
      x + 1,
      y + height - 1,
      x + width - 2,
      y + height - 1,
      "─",
      fg,
      bg
    );
    this.line(x, y + 1, x, y + height - 2, "│", fg, bg);
    this.line(x + width - 1, y + 1, x + width - 1, y + height - 2, "│", fg, bg);
    this.put(x, y, "╭", fg, bg);
    this.put(x + width - 1, y, "╮", fg, bg);
    this.put(x, y + height - 1, "╰", fg, bg);
    this.put(x + width - 1, y + height - 1, "╯", fg, bg);
  }
}

const cellKey = (cell: Cell) =>
  `${cell.glyph}|${cell.fg.join(",")}|${cell.bg?.join(",") ?? "-"}|${cell.bold ? 1 : 0}`;
const sgr = (cell: Cell) => {
  const background = cell.bg
    ? `48;2;${cell.bg[0]};${cell.bg[1]};${cell.bg[2]}`
    : "49";
  return `${CSI}0;${cell.bold ? "1;" : ""}38;2;${cell.fg[0]};${cell.fg[1]};${cell.fg[2]};${background}m`;
};

class DiffRenderer {
  private previous: string[];

  constructor(
    readonly width: number,
    readonly height: number
  ) {
    this.previous = Array.from({ length: width * height }, () => "");
  }

  frame(canvas: Canvas) {
    let output = `${CSI}?2026h`;
    for (let y = 0; y < this.height; y++) {
      let x = 0;
      while (x < this.width) {
        const index = y * this.width + x;
        const key = cellKey(canvas.cells[index]!);
        if (key === this.previous[index]) {
          x += 1;
          continue;
        }
        output += `${CSI}${y + 1};${x + 1}H`;
        let style = "";
        while (x < this.width) {
          const runIndex = y * this.width + x;
          const cell = canvas.cells[runIndex]!;
          const nextKey = cellKey(cell);
          if (nextKey === this.previous[runIndex] && x > 0) break;
          const nextStyle = `${cell.fg.join(",")}|${cell.bg?.join(",") ?? "-"}|${cell.bold}`;
          if (nextStyle !== style) {
            output += sgr(cell);
            style = nextStyle;
          }
          output += cell.glyph;
          this.previous[runIndex] = nextKey;
          x += 1;
        }
      }
    }
    return `${output}${CSI}0m${CSI}?25l${CSI}?2026l`;
  }
}

const title = (
  canvas: Canvas,
  name: string,
  detail: string,
  bg: Color | null = DARK
) => {
  canvas.text(2, 1, name.toUpperCase(), CYAN, bg, true);
  canvas.text(
    Math.max(2, canvas.width - detail.length - 2),
    1,
    detail,
    [116, 130, 160],
    bg
  );
  canvas.line(2, 2, canvas.width - 3, 2, "─", [32, 58, 78], bg);
};

const popcount = (value: number) => {
  let count = 0;
  for (let bits = value; bits; bits &= bits - 1) count += 1;
  return count;
};
const braille = (mask: number) => String.fromCodePoint(0x2800 + mask);

type QuantizedGlyph = { mask: number; foreground: Color; background: Color };
const quantizeSamples = (samples: readonly Color[]): QuantizedGlyph => {
  const pivot =
    samples.reduce((sum, color) => sum + luminance(color), 0) / samples.length;
  const high = samples.filter((color) => luminance(color) >= pivot);
  const low = samples.filter((color) => luminance(color) < pivot);
  const foreground = average(high, samples[0] ?? WHITE);
  const background = average(low, scale(foreground, 0.2));
  let mask = 0;
  for (const [index, sample] of samples.entries()) {
    if (colorDistance(sample, foreground) <= colorDistance(sample, background))
      mask |= BRAILLE_BITS[index] ?? 0;
  }
  return { mask, foreground, background };
};

const forgePixel = (x: number, y: number, time: number): Color => {
  const radius = Math.hypot(x, y);
  const angle = Math.atan2(y, x);
  const ring = Math.exp(
    -Math.abs(radius - 0.48 - Math.sin(angle * 3 + time * 1.7) * 0.1) * 22
  );
  const core = Math.exp(-radius * 4.5);
  const orbit = Math.exp(
    -Math.abs(Math.sin(angle * 2 - time) * 0.3 + radius - 0.66) * 28
  );
  const star = hash(Math.floor((x + 1) * 91) * 997 + Math.floor((y + 1) * 73));
  const base: Color = [3, 5, 18];
  return [
    clamp(base[0] + 235 * ring + 100 * core + (star > 0.992 ? 150 : 0), 0, 255),
    clamp(base[1] + 70 * ring + 230 * core + 160 * orbit, 0, 255),
    clamp(base[2] + 180 * ring + 180 * core + 240 * orbit, 0, 255),
  ] as Color;
};

class GlyphForgeScene implements Scene {
  render(canvas: Canvas, time: number) {
    canvas.clear(DARK);
    const top = 4;
    const rows = Math.max(1, canvas.height - top - 1);
    const raw: QuantizedGlyph[] = [];
    const counts = Array.from({ length: 256 }, () => 0);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const samples: Color[] = [];
        for (let sy = 0; sy < 4; sy++) {
          for (let sx = 0; sx < 2; sx++) {
            const nx = ((x * 2 + sx) / (canvas.width * 2) - 0.5) * 2.2;
            const ny = ((y * 4 + sy) / (rows * 4) - 0.5) * 1.55;
            samples.push(forgePixel(nx, ny, time));
          }
        }
        const glyph = quantizeSamples(samples);
        raw.push(glyph);
        counts[glyph.mask] = (counts[glyph.mask] ?? 0) + 1;
      }
    }
    const stages = [8, 16, 32, 64, 128, 256] as const;
    const codebookSize =
      stages[Math.min(stages.length - 1, Math.floor((time % 18) / 3))]!;
    const codebook = counts
      .map((count, mask) => ({ count, mask }))
      .sort((a, b) => b.count - a.count || a.mask - b.mask)
      .slice(0, codebookSize)
      .map(({ mask }) => mask);
    for (const [index, glyph] of raw.entries()) {
      let chosen = glyph.mask;
      if (codebookSize < 256) {
        let distance = Infinity;
        for (const candidate of codebook) {
          const next = popcount(candidate ^ glyph.mask);
          if (next < distance) {
            chosen = candidate;
            distance = next;
          }
        }
      }
      canvas.put(
        index % canvas.width,
        top + Math.floor(index / canvas.width),
        braille(chosen),
        glyph.foreground,
        glyph.background
      );
    }
    title(canvas, "glyph forge", `adaptive atlas ${codebookSize}/256`);
    canvas.center(
      3,
      "2×4 shape vectors  •  two-color fit  •  live codebook",
      [142, 156, 188]
    );
  }
}

type ClothPoint = {
  x: number;
  y: number;
  oldX: number;
  oldY: number;
  anchor?: [number, number];
};
type Particle = { x: number; y: number; vx: number; vy: number };

class KineticMatterScene implements Scene {
  private readonly cloth: ClothPoint[] = [];
  private readonly links: [number, number, number][] = [];
  private readonly fluid: Particle[] = [];
  private readonly bodies: Particle[] = [];
  private readonly trails: [number, number][][] = [];
  private accumulator = 0;
  private forcedMode: number | undefined;

  constructor(
    private readonly width: number,
    private readonly height: number
  ) {
    const columns = Math.max(8, Math.min(20, Math.floor(width / 4)));
    const rows = Math.max(6, Math.min(12, Math.floor(height / 2)));
    const spacing = Math.min(3, (width - 12) / columns);
    const startX = (width - (columns - 1) * spacing) / 2;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < columns; x++) {
        const px = startX + x * spacing;
        const py = 5 + y * 1.25;
        this.cloth.push({
          x: px,
          y: py,
          oldX: px,
          oldY: py,
          anchor: y === 0 && x % 3 === 0 ? [px, py] : undefined,
        });
        if (x > 0)
          this.links.push([y * columns + x - 1, y * columns + x, spacing]);
        if (y > 0)
          this.links.push([(y - 1) * columns + x, y * columns + x, 1.25]);
      }
    }
    for (let index = 0; index < 72; index++) {
      this.fluid.push({
        x: width * 0.3 + (index % 12) * 0.8,
        y: 6 + Math.floor(index / 12) * 0.65,
        vx: (hash(index * 3) - 0.5) * 0.2,
        vy: 0,
      });
    }
    const initial = [
      [width * 0.4, height * 0.45, 0, -2.4],
      [width * 0.6, height * 0.45, 0, 2.4],
      [width * 0.5, height * 0.65, 3.2, 0],
      [width * 0.5, height * 0.3, -2.8, 0],
    ];
    for (const [x, y, vx, vy] of initial)
      this.bodies.push({ x: x!, y: y!, vx: vx!, vy: vy! });
    this.trails.push(...this.bodies.map(() => []));
  }

  tick(dt: number, time: number, input: InputState) {
    for (let mode = 1; mode <= 3; mode++)
      if (input.keys.has(String(mode))) this.forcedMode = mode - 1;
    this.accumulator += Math.min(dt, 0.05);
    while (this.accumulator >= 1 / 120) {
      const step = 1 / 120;
      this.stepCloth(step, input);
      this.stepFluid(step, input);
      this.stepBodies(step, input);
      this.accumulator -= step;
    }
    if (input.keys.has("0")) this.forcedMode = undefined;
    void time;
  }

  private stepCloth(dt: number, input: InputState) {
    for (const point of this.cloth) {
      if (point.anchor) continue;
      const velocityX = (point.x - point.oldX) * 0.997;
      const velocityY = (point.y - point.oldY) * 0.997;
      point.oldX = point.x;
      point.oldY = point.y;
      point.x += velocityX;
      point.y += velocityY + 18 * dt * dt;
    }
    if (input.mouse.down) {
      let nearest = this.cloth[0]!;
      let nearestDistance = Infinity;
      for (const point of this.cloth) {
        const distance =
          (point.x - input.mouse.x) ** 2 + (point.y - input.mouse.y) ** 2;
        if (distance < nearestDistance) {
          nearest = point;
          nearestDistance = distance;
        }
      }
      nearest.x = input.mouse.x;
      nearest.y = input.mouse.y;
    }
    for (let iteration = 0; iteration < 5; iteration++) {
      for (const [leftIndex, rightIndex, rest] of this.links) {
        const left = this.cloth[leftIndex]!;
        const right = this.cloth[rightIndex]!;
        const dx = right.x - left.x;
        const dy = right.y - left.y;
        const distance = Math.max(0.001, Math.hypot(dx, dy));
        const correction = (distance - rest) / distance / 2;
        if (!left.anchor) {
          left.x += dx * correction;
          left.y += dy * correction;
        }
        if (!right.anchor) {
          right.x -= dx * correction;
          right.y -= dy * correction;
        }
      }
      for (const point of this.cloth) {
        if (point.anchor) [point.x, point.y] = point.anchor;
      }
    }
  }

  private stepFluid(dt: number, input: InputState) {
    const radius = 2.2;
    const densities = new Float64Array(this.fluid.length).fill(1);
    for (let leftIndex = 0; leftIndex < this.fluid.length; leftIndex++) {
      const left = this.fluid[leftIndex]!;
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < this.fluid.length;
        rightIndex++
      ) {
        const right = this.fluid[rightIndex]!;
        const distance = Math.hypot(right.x - left.x, right.y - left.y);
        if (distance >= radius) continue;
        const kernel = (1 - distance / radius) ** 3;
        densities[leftIndex] += kernel;
        densities[rightIndex] += kernel;
      }
    }
    const pressures = densities.map(
      (density) => Math.max(0, density - 2.2) * 34
    );
    for (let leftIndex = 0; leftIndex < this.fluid.length; leftIndex++) {
      const left = this.fluid[leftIndex]!;
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < this.fluid.length;
        rightIndex++
      ) {
        const right = this.fluid[rightIndex]!;
        const dx = right.x - left.x;
        const dy = right.y - left.y;
        const distance = Math.max(0.08, Math.hypot(dx, dy));
        if (distance >= radius) continue;
        const kernelGradient = (1 - distance / radius) ** 2;
        const pressure =
          ((pressures[leftIndex]! + pressures[rightIndex]!) *
            kernelGradient *
            dt) /
          (densities[leftIndex]! + densities[rightIndex]!);
        const nx = dx / distance;
        const ny = dy / distance;
        left.vx -= nx * pressure;
        left.vy -= ny * pressure;
        right.vx += nx * pressure;
        right.vy += ny * pressure;
        const viscosity = kernelGradient * 0.02;
        const relativeX = right.vx - left.vx;
        const relativeY = right.vy - left.vy;
        left.vx += relativeX * viscosity;
        left.vy += relativeY * viscosity;
        right.vx -= relativeX * viscosity;
        right.vy -= relativeY * viscosity;
      }
    }
    for (const particle of this.fluid) {
      if (input.mouse.down) {
        const dx = input.mouse.x - particle.x;
        const dy = input.mouse.y - particle.y;
        const distance = Math.max(2, Math.hypot(dx, dy));
        particle.vx += (dx / distance) * 18 * dt;
        particle.vy += (dy / distance) * 18 * dt;
      }
      particle.vy += 9 * dt;
      particle.vx *= 0.997;
      particle.vy *= 0.997;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      if (particle.x < 2 || particle.x > this.width - 3) {
        particle.x = clamp(particle.x, 2, this.width - 3);
        particle.vx *= -0.6;
      }
      if (particle.y < 4 || particle.y > this.height - 2) {
        particle.y = clamp(particle.y, 4, this.height - 2);
        particle.vy *= -0.45;
      }
    }
  }

  private stepBodies(dt: number, input: InputState) {
    for (let leftIndex = 0; leftIndex < this.bodies.length; leftIndex++) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < this.bodies.length;
        rightIndex++
      ) {
        const left = this.bodies[leftIndex]!;
        const right = this.bodies[rightIndex]!;
        const dx = right.x - left.x;
        const dy = right.y - left.y;
        const distanceSquared = Math.max(5, dx * dx + dy * dy);
        const force = (44 * dt) / distanceSquared;
        const distance = Math.sqrt(distanceSquared);
        left.vx += (dx / distance) * force;
        left.vy += (dy / distance) * force;
        right.vx -= (dx / distance) * force;
        right.vy -= (dy / distance) * force;
      }
    }
    for (const [index, body] of this.bodies.entries()) {
      if (input.mouse.down) {
        const dx = input.mouse.x - body.x;
        const dy = input.mouse.y - body.y;
        body.vx += dx * dt * 0.4;
        body.vy += dy * dt * 0.4;
      }
      body.x += body.vx * dt;
      body.y += body.vy * dt;
      if (body.x < 2 || body.x > this.width - 3) body.vx *= -1;
      if (body.y < 4 || body.y > this.height - 2) body.vy *= -1;
      body.x = clamp(body.x, 2, this.width - 3);
      body.y = clamp(body.y, 4, this.height - 2);
      const trail = this.trails[index]!;
      trail.push([body.x, body.y]);
      if (trail.length > 36) trail.shift();
    }
  }

  render(canvas: Canvas, time: number) {
    canvas.clear(DARK);
    const mode = this.forcedMode ?? Math.floor((time % 24) / 8);
    const labels = ["VERLET CLOTH", "SPH FLUID", "N-BODY GRAVITY"];
    title(
      canvas,
      "kinetic matter",
      `${labels[mode]}  •  mouse grabs  •  1/2/3`
    );
    if (mode === 0) {
      for (const [leftIndex, rightIndex] of this.links) {
        const left = this.cloth[leftIndex]!;
        const right = this.cloth[rightIndex]!;
        const strain = clamp(
          Math.hypot(right.x - left.x, right.y - left.y) / 3
        );
        canvas.line(
          left.x,
          left.y,
          right.x,
          right.y,
          "·",
          mix(CYAN, MAGENTA, strain)
        );
      }
      for (const point of this.cloth)
        canvas.put(
          point.x,
          point.y,
          point.anchor ? "◆" : "•",
          point.anchor ? GOLD : CYAN
        );
    } else if (mode === 1) {
      canvas.box(1, 3, canvas.width - 2, canvas.height - 4, [28, 94, 114]);
      for (const particle of this.fluid) {
        const speed = clamp(Math.hypot(particle.vx, particle.vy) / 8);
        canvas.put(particle.x, particle.y, "●", mix(CYAN, MAGENTA, speed));
      }
    } else {
      for (const [index, trail] of this.trails.entries()) {
        for (const [pointIndex, point] of trail.entries())
          canvas.put(
            point[0],
            point[1],
            "·",
            scale(hsv(index / this.trails.length), pointIndex / trail.length)
          );
      }
      for (const [index, body] of this.bodies.entries()) {
        const color = hsv(index / this.bodies.length + time * 0.03);
        canvas.ellipse(body.x, body.y, 2, 1, "·", scale(color, 0.55));
        canvas.put(body.x, body.y, "●", color, DARK, true);
      }
    }
  }
}

const fft = (input: Float32Array) => {
  const size = input.length;
  const real = new Float64Array(size);
  const imaginary = new Float64Array(size);
  for (let index = 0; index < size; index++) {
    const window = 0.5 - 0.5 * Math.cos((Math.PI * 2 * index) / (size - 1));
    real[index] = (input[index] ?? 0) * window;
  }
  for (let index = 1, target = 0; index < size; index++) {
    let bit = size >> 1;
    for (; target & bit; bit >>= 1) target ^= bit;
    target ^= bit;
    if (index < target)
      [real[index], real[target]] = [real[target]!, real[index]!];
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    for (let start = 0; start < size; start += length) {
      for (let offset = 0; offset < length / 2; offset++) {
        const cosine = Math.cos(angle * offset);
        const sine = Math.sin(angle * offset);
        const even = start + offset;
        const odd = even + length / 2;
        const oddReal = real[odd]! * cosine - imaginary[odd]! * sine;
        const oddImaginary = real[odd]! * sine + imaginary[odd]! * cosine;
        real[odd] = real[even]! - oddReal;
        imaginary[odd] = imaginary[even]! - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
      }
    }
  }
  return Array.from(
    { length: size / 2 },
    (_, index) => Math.hypot(real[index]!, imaginary[index]!) / size
  );
};

class AudioFeed {
  private readonly ring = new Float32Array(2048);
  private cursor = 0;
  private received = 0;
  private carry = Buffer.alloc(0);
  private child?: ReturnType<typeof spawn>;

  constructor(options: DemoOptions) {
    if (!options.audio && !options.mic) return;
    const source = options.audio
      ? ["-stream_loop", "-1", "-i", options.audio]
      : process.platform === "darwin"
        ? ["-f", "avfoundation", "-i", ":0"]
        : ["-f", "pulse", "-i", "default"];
    const child = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        ...source,
        "-vn",
        "-f",
        "f32le",
        "-ac",
        "1",
        "-ar",
        "8192",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "ignore"] }
    );
    child.on("error", () => {});
    child.stdout?.on("data", (chunk: Buffer) => this.push(chunk));
    this.child = child;
  }

  private push(chunk: Buffer) {
    const data = Buffer.concat([this.carry, chunk]);
    const complete = data.length - (data.length % 4);
    for (let offset = 0; offset < complete; offset += 4) {
      this.ring[this.cursor] = data.readFloatLE(offset);
      this.cursor = (this.cursor + 1) % this.ring.length;
      this.received += 1;
    }
    this.carry = data.subarray(complete);
  }

  spectrum() {
    if (this.received < 256) return undefined;
    const samples = new Float32Array(256);
    for (let index = 0; index < samples.length; index++)
      samples[index] =
        this.ring[
          (this.cursor - samples.length + index + this.ring.length) %
            this.ring.length
        ]!;
    return fft(samples);
  }

  dispose() {
    this.child?.kill("SIGTERM");
  }
}

class SoundReactorScene implements Scene {
  private readonly audio: AudioFeed;
  private spectrum = Array.from({ length: 128 }, () => 0);
  private readonly requestedSource: string;
  private source = "GENERATIVE FFT";
  private gainPeak = 0.02;
  private kick = 0;

  constructor(options: DemoOptions) {
    this.audio = new AudioFeed(options);
    this.requestedSource = options.mic
      ? "LIVE MIC FFT"
      : options.audio
        ? `FILE FFT: ${basename(options.audio)}`
        : "GENERATIVE FFT";
  }

  tick(dt: number, time: number, input: InputState) {
    const live = this.audio.spectrum();
    if (live) {
      const peak = Math.max(...live);
      this.gainPeak = Math.max(
        0.002,
        peak,
        this.gainPeak * Math.exp(-dt * 1.4)
      );
      const noiseFloor = 0.0005;
      this.spectrum = live.map(
        (value) =>
          clamp(
            (value - noiseFloor) /
              Math.max(noiseFloor, this.gainPeak - noiseFloor)
          ) ** 0.55
      );
      this.source = this.requestedSource;
    } else {
      const samples = Float32Array.from({ length: 256 }, (_, index) => {
        const sampleTime = time + index / 8192;
        const beat = 0.25 + Math.max(0, Math.sin(time * 6.2)) * 0.75;
        return (
          Math.sin(sampleTime * Math.PI * 2 * 96) * beat * 0.8 +
          Math.sin(sampleTime * Math.PI * 2 * (420 + Math.sin(time) * 90)) *
            0.42 +
          Math.sin(sampleTime * Math.PI * 2 * 2100) *
            (0.12 + hash(Math.floor(time * 8)) * 0.2)
        );
      });
      this.spectrum = fft(samples).map((value) => clamp(value * 5));
      this.source =
        this.requestedSource === "GENERATIVE FFT"
          ? this.requestedSource
          : `${this.requestedSource} UNAVAILABLE • GENERATIVE FFT`;
    }
    const bass =
      this.spectrum.slice(1, 9).reduce((sum, value) => sum + value, 0) / 8;
    this.kick = Math.max(
      this.kick * Math.exp(-dt * 7),
      bass,
      input.keys.has(" ") ? 1 : 0
    );
  }

  render(canvas: Canvas, time: number) {
    canvas.clear(DARK);
    const bass =
      this.spectrum.slice(1, 9).reduce((sum, value) => sum + value, 0) / 8;
    const mids =
      this.spectrum.slice(9, 44).reduce((sum, value) => sum + value, 0) / 35;
    const treble =
      this.spectrum.slice(44).reduce((sum, value) => sum + value, 0) / 84;
    title(canvas, "sound reactor", `${this.source}  •  space = beat`);
    const centerX = canvas.width / 2;
    const centerY = canvas.height * 0.47;
    const maxRadius = Math.max(canvas.width, canvas.height) * 0.55;
    for (let ring = 0; ring < 11; ring++) {
      const phase = (ring / 11 + time * (0.12 + bass * 0.2)) % 1;
      const radius = 1 + phase * maxRadius;
      const color = scale(
        hsv(time * 0.06 + phase * 0.6),
        (1 - phase) * 0.8 + 0.1
      );
      canvas.ellipse(
        centerX,
        centerY,
        radius * 1.8,
        radius * 0.55,
        "·",
        color,
        DARK,
        42
      );
    }
    let previousY = centerY;
    for (let x = 1; x < canvas.width - 1; x++) {
      const value =
        this.spectrum[Math.floor((x / canvas.width) * this.spectrum.length)] ??
        0;
      const y =
        centerY +
        Math.sin(x * 0.24 + time * (4 + mids * 5)) *
          (1 + value * 5 + this.kick * 2);
      if (x > 1)
        canvas.line(
          x - 1,
          previousY,
          x,
          y,
          "•",
          mix(CYAN, MAGENTA, x / canvas.width)
        );
      previousY = y;
    }
    const bars = Math.min(32, Math.floor(canvas.width / 2));
    for (let bar = 0; bar < bars; bar++) {
      const value = this.spectrum[Math.floor((bar / bars) * 100)] ?? 0;
      const height = Math.round(value * (canvas.height * 0.24));
      const x = Math.floor((bar / bars) * canvas.width);
      for (let y = 0; y < height; y++)
        canvas.put(
          x,
          canvas.height - 2 - y,
          "█",
          hsv((bar / bars) * 0.65 + time * 0.03),
          DARK
        );
    }
    canvas.text(
      2,
      canvas.height - 1,
      `BASS ${bass.toFixed(2)}  MID ${mids.toFixed(2)}  AIR ${treble.toFixed(2)}`,
      [116, 130, 160]
    );
  }

  dispose() {
    this.audio.dispose();
  }
}

type GraphNode = {
  parent?: number;
  position: Vec3;
  rotation: Vec3;
  vertices: Vec3[];
  edges: [number, number][];
  color: Color;
};

const rotate = ([x, y, z]: Vec3, [rx, ry, rz]: Vec3): Vec3 => {
  const [sinX, cosX] = [Math.sin(rx), Math.cos(rx)];
  const [sinY, cosY] = [Math.sin(ry), Math.cos(ry)];
  const [sinZ, cosZ] = [Math.sin(rz), Math.cos(rz)];
  const y1 = y * cosX - z * sinX;
  const z1 = y * sinX + z * cosX;
  const x2 = x * cosY + z1 * sinY;
  const z2 = -x * sinY + z1 * cosY;
  return [x2 * cosZ - y1 * sinZ, x2 * sinZ + y1 * cosZ, z2];
};
const cubeGeometry = () => {
  const vertices: Vec3[] = [];
  for (const x of [-1, 1])
    for (const y of [-1, 1]) for (const z of [-1, 1]) vertices.push([x, y, z]);
  const edges: [number, number][] = [];
  for (let left = 0; left < vertices.length; left++) {
    for (let right = left + 1; right < vertices.length; right++) {
      const differences = vertices[left]!.filter(
        (value, axis) => value !== vertices[right]![axis]
      ).length;
      if (differences === 1) edges.push([left, right]);
    }
  }
  return { vertices, edges };
};
const tetraGeometry = () => ({
  vertices: [
    [1, 1, 1],
    [-1, -1, 1],
    [-1, 1, -1],
    [1, -1, -1],
  ] as Vec3[],
  edges: [
    [0, 1],
    [0, 2],
    [0, 3],
    [1, 2],
    [1, 3],
    [2, 3],
  ] as [number, number][],
});
const kittyChunks = (payload: string, controls: string) => {
  let output = "";
  for (let offset = 0; offset < payload.length; offset += 4096) {
    const first = offset === 0;
    const last = offset + 4096 >= payload.length;
    output += `${ESC}_G${first ? `${controls},` : ""}m=${last ? 0 : 1};${payload.slice(offset, offset + 4096)}${ESC}\\`;
  }
  return output;
};

class TerminalSceneGraphScene implements Scene {
  private readonly nodes: GraphNode[];
  private yaw = 0;
  private pitch = -0.08;
  private nativeId = 0;
  private nativeTime = -1;

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly nativeImages: boolean
  ) {
    const cube = cubeGeometry();
    const tetra = tetraGeometry();
    this.nodes = [
      {
        position: [0, 0, 9],
        rotation: [0, 0, 0],
        vertices: [],
        edges: [],
        color: CYAN,
      },
      {
        parent: 0,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        ...cube,
        color: CYAN,
      },
      {
        parent: 1,
        position: [3.2, 0, 0],
        rotation: [0, 0, 0],
        ...tetra,
        color: MAGENTA,
      },
      {
        parent: 2,
        position: [2, 0, 0],
        rotation: [0, 0, 0],
        ...cube,
        color: GOLD,
      },
    ];
  }

  tick(_dt: number, time: number, input: InputState) {
    if (input.keys.has("left")) this.yaw -= 0.12;
    if (input.keys.has("right")) this.yaw += 0.12;
    if (input.keys.has("up")) this.pitch -= 0.08;
    if (input.keys.has("down")) this.pitch += 0.08;
    this.nodes[0]!.rotation = [0, time * 0.22, 0];
    this.nodes[1]!.rotation = [time * 0.37, time * 0.55, time * 0.17];
    this.nodes[2]!.rotation = [time * 0.8, -time * 1.1, time * 0.5];
    this.nodes[3]!.rotation = [-time * 1.4, time * 1.1, time];
  }

  private worldPoint(nodeIndex: number, point: Vec3): Vec3 {
    let result = point;
    let index: number | undefined = nodeIndex;
    while (index !== undefined) {
      const node: GraphNode = this.nodes[index]!;
      const rotated = rotate(result, node.rotation);
      result = [
        rotated[0] + node.position[0],
        rotated[1] + node.position[1],
        rotated[2] + node.position[2],
      ];
      index = node.parent;
    }
    return result;
  }

  private project(point: Vec3): [number, number, number] | undefined {
    const cameraPoint = rotate(
      [point[0], point[1], point[2] - 9],
      [this.pitch, this.yaw, 0]
    );
    cameraPoint[2] += 9;
    if (cameraPoint[2] <= 0.2) return undefined;
    const focal = Math.min(this.width, this.height * 2) * 0.7;
    return [
      this.width / 2 + (cameraPoint[0] / cameraPoint[2]) * focal,
      this.height / 2 + (cameraPoint[1] / cameraPoint[2]) * focal * 0.5,
      cameraPoint[2],
    ];
  }

  render(canvas: Canvas, time: number) {
    canvas.clear(this.nativeImages ? null : DARK);
    if (!this.nativeImages) {
      for (let index = 0; index < 90; index++) {
        const x = Math.floor(hash(index * 9) * canvas.width);
        const y = 3 + Math.floor(hash(index * 17) * (canvas.height - 4));
        const pulse = 0.2 + 0.7 * hash(index + Math.floor(time * 2));
        canvas.put(x, y, "·", scale(index % 7 === 0 ? CYAN : WHITE, pulse));
      }
    }
    for (let z = 2; z < 15; z += 1.5) {
      let previous: [number, number, number] | undefined;
      for (let x = -8; x <= 8; x += 1) {
        const point = this.project([
          x,
          2.4 + Math.sin(x * 0.5 + z + time) * 0.18,
          z,
        ]);
        if (point && previous)
          canvas.line(
            previous[0],
            previous[1],
            point[0],
            point[1],
            "·",
            scale(CYAN, 0.22),
            null
          );
        previous = point;
      }
    }
    for (const [nodeIndex, node] of this.nodes.entries()) {
      const projected = node.vertices.map((vertex) =>
        this.project(this.worldPoint(nodeIndex, vertex))
      );
      for (const [left, right] of node.edges) {
        const a = projected[left];
        const b = projected[right];
        if (a && b) canvas.line(a[0], a[1], b[0], b[1], "•", node.color, null);
      }
    }
    title(
      canvas,
      "terminal scene graph",
      `hierarchy + native texture  •  arrows orbit`,
      null
    );
    canvas.text(
      2,
      canvas.height - 1,
      "ROOT → CUBE → TETRA → SATELLITE",
      [142, 156, 188],
      null
    );
  }

  nativeFrame(time: number) {
    if (!this.nativeImages || time - this.nativeTime < 0.12) return "";
    this.nativeTime = time;
    this.nativeId = this.nativeId === 71 ? 72 : 71;
    const width = 120;
    const height = 72;
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const nx = x / width;
        const ny = y / height;
        const aurora = Math.max(
          0,
          Math.sin(nx * 8 + time + Math.sin(ny * 5 - time) * 1.7)
        );
        const band =
          Math.exp(
            -((ny - 0.42 - Math.sin(nx * 4 + time * 0.3) * 0.12) ** 2) * 34
          ) * aurora;
        const offset = (y * width + x) * 3;
        pixels[offset] = Math.round(3 + band * 60);
        pixels[offset + 1] = Math.round(5 + band * 175);
        pixels[offset + 2] = Math.round(18 + band * 160 + (1 - ny) * 20);
      }
    }
    const previous = this.nativeId === 71 ? 72 : 71;
    return (
      `${CSI}1;1H` +
      kittyChunks(
        pixels.toString("base64"),
        `a=T,f=24,s=${width},v=${height},i=${this.nativeId},z=-2,c=${this.width},r=${this.height},q=2,C=1`
      ) +
      `${ESC}_Ga=d,d=I,i=${previous},q=2${ESC}\\`
    );
  }

  dispose() {
    return `${ESC}_Ga=d,d=A,q=2${ESC}\\`;
  }
}

const VFX_NAMES = [
  "SPLIT-FLAP CONTENT",
  "NEON BORDER CHASE",
  "CAMERA SHUTTER",
  "KINTSUGI REPAIR",
  "BIOLUMINESCENT DEPTH",
  "SURFACE ELEVATION",
  "PAINT SPLATTER",
  "STARGATE APERTURE",
  "TERMINAL-OWNED RECTANGLES",
] as const;

class VfxAnthologyScene implements Scene {
  private rectangleX = 5;

  constructor(private readonly nativeRectangles: boolean) {}

  render(canvas: Canvas, time: number) {
    canvas.clear(DARK);
    const duration = 3;
    const act = Math.floor((time % (VFX_NAMES.length * duration)) / duration);
    const local = time % duration;
    title(
      canvas,
      "vfx anthology",
      `${String(act + 1).padStart(2, "0")}/${VFX_NAMES.length}  ${VFX_NAMES[act]}`
    );
    switch (act) {
      case 0:
        this.splitFlap(canvas, local);
        break;
      case 1:
        this.neon(canvas, local);
        break;
      case 2:
        this.shutter(canvas, local);
        break;
      case 3:
        this.kintsugi(canvas, local);
        break;
      case 4:
        this.bioluminescence(canvas, local);
        break;
      case 5:
        this.elevation(canvas, local);
        break;
      case 6:
        this.paint(canvas, local);
        break;
      case 7:
        this.stargate(canvas, local);
        break;
      default:
        this.rectangles(canvas, local);
    }
  }

  private splitFlap(canvas: Canvas, time: number) {
    const target = "TERMINAL ALCHEMY";
    const alphabet = " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const startX = Math.floor((canvas.width - target.length * 3) / 2);
    for (const [index, wanted] of [...target].entries()) {
      const progress = clamp(time * 1.5 - index * 0.08);
      const flap =
        progress >= 1
          ? wanted
          : alphabet[Math.floor((time * 22 + index * 7) % alphabet.length)]!;
      const x = startX + index * 3;
      canvas.box(x, Math.floor(canvas.height / 2) - 2, 3, 5, [40, 64, 82]);
      canvas.put(
        x + 1,
        Math.floor(canvas.height / 2),
        flap,
        progress >= 1 ? CYAN : [130, 145, 168],
        DARK,
        true
      );
      canvas.line(
        x,
        Math.floor(canvas.height / 2) + 1,
        x + 2,
        Math.floor(canvas.height / 2) + 1,
        "─",
        [28, 42, 58]
      );
    }
  }

  private neon(canvas: Canvas, time: number) {
    const width = Math.min(64, canvas.width - 10);
    const height = Math.min(16, canvas.height - 8);
    const x = Math.floor((canvas.width - width) / 2);
    const y = Math.floor((canvas.height - height) / 2) + 1;
    canvas.box(x, y, width, height, [24, 62, 76]);
    const perimeter = (width - 1) * 2 + (height - 1) * 2;
    for (let step = 0; step < perimeter; step++) {
      let px: number;
      let py: number;
      if (step < width) [px, py] = [x + step, y];
      else if (step < width + height)
        [px, py] = [x + width - 1, y + step - width];
      else if (step < width * 2 + height)
        [px, py] = [x + width - 1 - (step - width - height), y + height - 1];
      else [px, py] = [x, y + height - 1 - (step - width * 2 - height)];
      const distance =
        (((step - time * 34) % perimeter) + perimeter) % perimeter;
      const glow = Math.exp(-Math.min(distance, perimeter - distance) * 0.22);
      if (glow > 0.08)
        canvas.put(px, py, "█", mix([22, 44, 58], MAGENTA, glow));
    }
    canvas.center(
      Math.floor(canvas.height / 2),
      "NEON SIGNAL",
      WHITE,
      DARK,
      true
    );
  }

  private shutter(canvas: Canvas, time: number) {
    const cx = canvas.width / 2;
    const cy = canvas.height / 2 + 1;
    const radius = Math.min(canvas.width / 4, canvas.height / 2 - 3);
    const aperture = 0.25 + 0.75 * Math.abs(Math.sin(time * 1.25));
    canvas.ellipse(cx, cy, radius * 2, radius, "•", [70, 84, 112]);
    for (let blade = 0; blade < 10; blade++) {
      const angle = (blade / 10) * Math.PI * 2 + time * 0.8;
      const inner = radius * aperture;
      canvas.line(
        cx + Math.cos(angle) * inner * 2,
        cy + Math.sin(angle) * inner,
        cx + Math.cos(angle + 0.8) * radius * 2,
        cy + Math.sin(angle + 0.8) * radius,
        "█",
        mix([42, 48, 68], CYAN, blade / 20)
      );
    }
    canvas.center(cy, "IRIS", WHITE, DARK, true);
  }

  private kintsugi(canvas: Canvas, time: number) {
    const cx = Math.floor(canvas.width / 2);
    const top = 5;
    const bottom = canvas.height - 3;
    const radius = Math.min(20, canvas.width / 4);
    for (let y = top; y <= bottom; y++) {
      const progress = (y - top) / (bottom - top);
      const half = radius * (0.45 + Math.sin(progress * Math.PI) * 0.55);
      canvas.put(cx - half, y, "▐", [66, 92, 126]);
      canvas.put(cx + half, y, "▌", [66, 92, 126]);
    }
    canvas.line(
      cx - radius * 0.6,
      top + 2,
      cx + radius * 0.1,
      top + 7,
      "·",
      [60, 68, 88]
    );
    canvas.line(
      cx + radius * 0.1,
      top + 7,
      cx - radius * 0.2,
      bottom - 4,
      "·",
      [60, 68, 88]
    );
    canvas.line(
      cx + radius * 0.1,
      top + 7,
      cx + radius * 0.7,
      top + 10,
      "·",
      [60, 68, 88]
    );
    const repair = clamp((time - 0.5) / 2);
    const paths = [
      [cx - radius * 0.6, top + 2, cx + radius * 0.1, top + 7],
      [cx + radius * 0.1, top + 7, cx - radius * 0.2, bottom - 4],
      [cx + radius * 0.1, top + 7, cx + radius * 0.7, top + 10],
    ];
    for (const path of paths) {
      const [x0, y0, x1, y1] = path;
      canvas.line(
        x0!,
        y0!,
        x0! + (x1! - x0!) * repair,
        y0! + (y1! - y0!) * repair,
        "◆",
        GOLD
      );
    }
  }

  private bioluminescence(canvas: Canvas, time: number) {
    for (let index = 0; index < 170; index++) {
      const depth = hash(index * 5);
      const x =
        (hash(index * 13) * canvas.width +
          Math.sin(time * (0.3 + depth) + index) * 8 * depth +
          canvas.width) %
        canvas.width;
      const y =
        4 +
        ((hash(index * 19) * (canvas.height - 5) + time * (0.4 + depth * 2)) %
          (canvas.height - 5));
      const pulse = clamp(((Math.sin(time * 3 + index) + 1) / 2) * depth);
      canvas.put(
        x,
        y,
        depth > 0.72 ? "●" : "·",
        mix([16, 50, 72], CYAN, pulse)
      );
    }
    canvas.center(
      Math.floor(canvas.height / 2),
      "THE DEEP IS LISTENING",
      [116, 255, 220],
      DARK,
      true
    );
  }

  private elevation(canvas: Canvas, time: number) {
    const lift = (Math.sin(time * 2.4) + 1) / 2;
    const width = Math.min(46, canvas.width - 12);
    const height = 9;
    const x = Math.floor((canvas.width - width) / 2);
    const y = Math.floor(canvas.height / 2 - height / 2 - lift * 2);
    const shadow = Math.round(1 + lift * 4);
    for (let row = 0; row < height; row++)
      canvas.line(
        x + shadow,
        y + row + Math.ceil(shadow / 2),
        x + width - 1 + shadow,
        y + row + Math.ceil(shadow / 2),
        "░",
        scale(MAGENTA, 0.18)
      );
    for (let row = 1; row < height - 1; row++)
      canvas.line(
        x + 1,
        y + row,
        x + width - 2,
        y + row,
        " ",
        WHITE,
        [17, 24, 40]
      );
    canvas.box(x, y, width, height, mix(CYAN, WHITE, lift * 0.4), [17, 24, 40]);
    canvas.center(y + 3, "SURFACE / ELEVATION", WHITE, [17, 24, 40], true);
    canvas.center(
      y + 5,
      `z = ${(lift * 24).toFixed(1)}px`,
      [116, 130, 160],
      [17, 24, 40]
    );
  }

  private paint(canvas: Canvas, time: number) {
    for (let splat = 0; splat < 18; splat++) {
      const birth = splat * 0.13;
      const age = time - birth;
      if (age < 0) continue;
      const cx = hash(splat * 17) * canvas.width;
      const cy = 4 + hash(splat * 29) * (canvas.height - 6);
      const radius = Math.min(5, age * (2 + hash(splat) * 5));
      const color = hsv(splat * 0.13 + time * 0.03);
      canvas.ellipse(cx, cy, radius * 1.8, radius, "•", color, DARK, 20);
      canvas.put(cx, cy, "█", color);
      for (let drop = 0; drop < 4; drop++) {
        const angle = hash(splat * 41 + drop) * Math.PI * 2;
        canvas.put(
          cx + Math.cos(angle) * radius * 2.2,
          cy + Math.sin(angle) * radius,
          "·",
          color
        );
      }
    }
  }

  private stargate(canvas: Canvas, time: number) {
    const cx = canvas.width / 2;
    const cy = canvas.height / 2 + 1;
    const radius = Math.min(canvas.width / 4, canvas.height / 2 - 3);
    for (let ring = 0; ring < 4; ring++)
      canvas.ellipse(
        cx,
        cy,
        (radius + ring * 1.4) * 2,
        radius + ring * 0.7,
        ring === 1 ? "◆" : "·",
        ring === 1 ? GOLD : scale(CYAN, 0.3 + ring * 0.12)
      );
    for (let chevron = 0; chevron < 9; chevron++) {
      const angle = (chevron / 9) * Math.PI * 2 - Math.PI / 2;
      const active = chevron <= Math.floor(time * 3);
      canvas.put(
        cx + Math.cos(angle) * (radius + 2) * 2,
        cy + Math.sin(angle) * (radius + 2),
        active ? "◆" : "◇",
        active ? GOLD : [70, 80, 104]
      );
    }
    const open = clamp((time - 1) * 1.2);
    for (let y = -radius + 1; y < radius; y++) {
      const half = Math.sqrt(Math.max(0, radius * radius - y * y)) * 2 * open;
      canvas.line(
        cx - half,
        cy + y,
        cx + half,
        cy + y,
        "≈",
        mix([16, 42, 74], CYAN, 0.45 + hash(y) * 0.4)
      );
    }
  }

  private rectangles(canvas: Canvas, time: number) {
    const y = Math.floor(canvas.height / 2);
    canvas.line(4, y + 2, canvas.width - 5, y + 2, "─", [44, 70, 90]);
    const x = this.nativeRectangles
      ? 5
      : 5 + Math.floor(clamp(time / 2.7) * (canvas.width - 14));
    canvas.text(x, y, "███", MAGENTA, [42, 12, 36], true);
    canvas.center(
      y - 4,
      "DECCRA copies the sprite; DECFRA erases its old rectangle",
      [146, 160, 190]
    );
    canvas.center(
      y - 2,
      this.nativeRectangles
        ? "DECCRA / DECFRA CAPABILITY PROBE"
        : "CELL EMULATION",
      CYAN
    );
  }

  nativeFrame(time: number) {
    if (!this.nativeRectangles) return "";
    const act = Math.floor((time % (VFX_NAMES.length * 3)) / 3);
    const height = Math.min(process.stdout.rows ?? 30, 38);
    if (act !== VFX_NAMES.length - 1) {
      if (this.rectangleX === 5) return "";
      const row = Math.floor(height / 2) + 1;
      const oldColumn = this.rectangleX + 1;
      this.rectangleX = 5;
      return `${CSI}?2026h${CSI}32;${row};${oldColumn};${row};${oldColumn + 2}$x${CSI}?2026l`;
    }
    const width = Math.min(process.stdout.columns ?? 80, 110);
    const local = time % 3;
    const x = 5 + Math.floor(clamp(local / 2.7) * (width - 14));
    if (x === this.rectangleX) return "";
    const row = Math.floor(height / 2) + 1;
    const oldColumn = this.rectangleX + 1;
    const column = x + 1;
    this.rectangleX = x;
    const copy = `${CSI}${row};${oldColumn};${row};${oldColumn + 2};1;${row};${column};1$v`;
    const fill = `${CSI}32;${row};${oldColumn};${row};${oldColumn + 2}$x`;
    return `${CSI}?2026h${copy}${fill}${CSI}?2026l`;
  }
}

const createScene = (
  name: DemoName,
  width: number,
  height: number,
  options: DemoOptions
): Scene => {
  switch (name) {
    case "glyph-forge":
      return new GlyphForgeScene();
    case "kinetic-matter":
      return new KineticMatterScene(width, height);
    case "sound-reactor":
      return new SoundReactorScene(options);
    case "terminal-scene-graph":
      return new TerminalSceneGraphScene(width, height, options.nativeImages);
    case "vfx-anthology":
      return new VfxAnthologyScene(options.nativeRectangles);
  }
};

const numberArgument = (
  args: readonly string[],
  flag: string,
  fallback: number
) => {
  const index = args.indexOf(flag);
  if (index < 0) return fallback;
  const value = Number(args[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const stringArgument = (args: readonly string[], flag: string) => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};
const defaults: Record<DemoName, number> = {
  "glyph-forge": 18,
  "kinetic-matter": 24,
  "sound-reactor": 24,
  "terminal-scene-graph": 24,
  "vfx-anthology": 27,
};

const selfCheck = () => {
  assert.equal(braille(0), "⠀");
  assert.equal(braille(255), "⣿");
  const quantized = quantizeSamples([
    WHITE,
    DARK,
    WHITE,
    DARK,
    WHITE,
    DARK,
    WHITE,
    DARK,
  ]);
  assert.equal(quantized.mask, 71);
  const signal = Float32Array.from({ length: 256 }, (_, index) =>
    Math.sin((2 * Math.PI * 16 * index) / 256)
  );
  const spectrum = fft(signal);
  assert.equal(spectrum.indexOf(Math.max(...spectrum)), 16);
  const input: InputState = {
    keys: new Set(),
    mouse: { x: 20, y: 10, down: false },
  };
  const options: DemoOptions = {
    seconds: 1,
    fps: 20,
    mic: false,
    nativeImages: false,
    nativeRectangles: false,
  };
  for (const name of DEMO_NAMES) {
    const scene = createScene(name, 64, 24, options);
    const times =
      name === "vfx-anthology"
        ? Array.from({ length: 9 }, (_, index) => index * 3 + 1.4)
        : [1.4];
    for (const time of times) {
      const canvas = new Canvas(64, 24);
      scene.tick?.(1 / 60, time, input);
      scene.render(canvas, time, input);
      assert(
        canvas.cells.some((cell) => cell.glyph !== " "),
        `${name} rendered an empty frame at ${time}s`
      );
    }
    scene.dispose?.();
  }
  const nativeVfx = new VfxAnthologyScene(true);
  const nativeCanvas = new Canvas(64, 24);
  nativeVfx.render(nativeCanvas, 24);
  assert.equal(nativeVfx.nativeFrame(24), "");
  assert.match(nativeVfx.nativeFrame(25.4), /\$v.*\$x/u);
  assert.match(nativeVfx.nativeFrame(0), /\$x/u);
  console.log(
    "Frontier demos self-check passed: adaptive glyphs, fixed-step physics, FFT, scene graph, and nine VFX acts."
  );
};

const parseInput = (text: string, input: InputState) => {
  for (const match of text.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)) {
    input.mouse.x = Number(match[2]) - 1;
    input.mouse.y = Number(match[3]) - 1;
    input.mouse.down = match[4] === "M" && (Number(match[1]) & 3) !== 3;
  }
  if (text.includes("\x1b[D")) input.keys.add("left");
  if (text.includes("\x1b[C")) input.keys.add("right");
  if (text.includes("\x1b[A")) input.keys.add("up");
  if (text.includes("\x1b[B")) input.keys.add("down");
  for (const character of text.replaceAll(/\x1b\[[^A-Za-z]*[A-Za-z]/g, ""))
    input.keys.add(character);
};

export const runFrontierDemo = async (
  name: DemoName,
  args = process.argv.slice(2)
) => {
  if (args.includes("--check")) {
    selfCheck();
    return;
  }
  if (args.includes("--list")) {
    console.log(DEMO_NAMES.join("\n"));
    return;
  }
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.log(
      `Run ${basename(process.argv[1] ?? name)} in an interactive terminal, or pass --check.`
    );
    return;
  }
  const minimumWidth = name === "vfx-anthology" ? 48 : 40;
  if (
    (process.stdout.columns ?? 90) < minimumWidth ||
    (process.stdout.rows ?? 30) < 16
  ) {
    console.error(`${name} requires at least ${minimumWidth}x16 cells.`);
    return;
  }
  const options: DemoOptions = {
    seconds: numberArgument(args, "--seconds", defaults[name]),
    fps: numberArgument(args, "--fps", 24),
    audio: stringArgument(args, "--audio"),
    mic: args.includes("--mic"),
    nativeImages:
      !args.includes("--cells-only") &&
      (args.includes("--native-images") ||
        process.env.TERM_PROGRAM === "ghostty" ||
        Boolean(process.env.KITTY_WINDOW_ID)),
    nativeRectangles: !args.includes("--cells-only"),
  };
  const width = Math.min(process.stdout.columns ?? 90, 110);
  const height = Math.min(process.stdout.rows ?? 30, 38);
  const renderer = new DiffRenderer(width, height);
  const canvas = new Canvas(width, height);
  const input: InputState = {
    keys: new Set(),
    mouse: { x: width / 2, y: height / 2, down: false },
  };
  const scene = createScene(name, width, height, options);
  let stopped = false;
  let cleaned = false;
  const onData = (data: Buffer) => {
    const text = data.toString();
    if (
      text.includes("q") ||
      (text.includes("\x1b") && !text.includes("\x1b[")) ||
      text.includes("\x03")
    )
      stopped = true;
    parseInput(text, input);
  };
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    stopped = true;
    const disposal = scene.dispose?.() ?? "";
    process.stdout.write(
      `${disposal}${CSI}?1003l${CSI}?1006l${CSI}0m${CSI}?7h${CSI}?25h${CSI}?1049l`
    );
    process.stdin.off("data", onData);
    process.stdin.setRawMode(false);
    process.stdin.pause();
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.stdout.write(
    `${CSI}?1049h${CSI}2J${CSI}?7l${CSI}?25l${CSI}?1003h${CSI}?1006h`
  );
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", onData);
  const started = performance.now();
  let previous = started;
  let deadline = started;
  try {
    while (!stopped) {
      const now = performance.now();
      const time = (now - started) / 1000;
      if (time >= options.seconds) break;
      const dt = (now - previous) / 1000;
      previous = now;
      scene.tick?.(dt, time, input);
      scene.render(canvas, time, input);
      const native = scene.nativeFrame?.(time) ?? "";
      process.stdout.write(`${native}${renderer.frame(canvas)}`);
      input.keys.clear();
      deadline += 1000 / options.fps;
      const wait = deadline - performance.now();
      if (wait > 0) await sleep(wait);
      else deadline = performance.now();
    }
  } finally {
    cleanup();
    process.off("SIGINT", cleanup);
    process.off("SIGTERM", cleanup);
  }
};

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const requested = process.argv[2];
  if (!DEMO_NAMES.includes(requested as DemoName)) {
    console.log(
      `Usage: bun scripts/frontier-demos.ts <${DEMO_NAMES.join("|")}> [--seconds N] [--fps N]`
    );
    process.exitCode = 1;
  } else {
    await runFrontierDemo(requested as DemoName, process.argv.slice(3));
  }
}
