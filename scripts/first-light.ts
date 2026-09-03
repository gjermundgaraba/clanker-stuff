// FIRST LIGHT — one cinematic terminal demo that climbs the rendering ladder:
// native cursor → spring typography → advected ink → shape-aware ASCII →
// quadrant cells → indexed palette motion → truecolor GPU pixels → prompt.
//
// Run: bun scripts/first-light.ts [--seconds 34] [--fps 30]
// Check: bun scripts/first-light.ts --check

/// <reference types="@webgpu/types" />

import assert from "node:assert/strict";

import { setupGlobals } from "bun-webgpu";

setupGlobals();

const ESC = "\x1b";
const CSI = `${ESC}[`;
const ST = `${ESC}\\`;
const STORY_SECONDS = 34;
const PALETTE_INDICES = Array.from({ length: 16 }, (_, index) => index + 16);
const QUADRANTS = [
  " ",
  "▘",
  "▝",
  "▀",
  "▖",
  "▌",
  "▞",
  "▛",
  "▗",
  "▚",
  "▐",
  "▜",
  "▄",
  "▙",
  "▟",
  "█",
] as const;

type Rgb = readonly [number, number, number];
type Cell = {
  char: string;
  foreground: number;
  background: number;
  indexed?: boolean;
};
type Cursor = { x: number; y: number; style: 1 | 3 | 5 };
type Glyph = { char: string; vector: number[] };

const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(high, value));
const mix = (from: number, to: number, amount: number) =>
  from + (to - from) * amount;
const smoothstep = (edge0: number, edge1: number, value: number) => {
  const unit = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return unit * unit * (3 - 2 * unit);
};
const pack = (red: number, green: number, blue: number, step = 1) => {
  const quantize = (value: number) =>
    clamp(Math.round(value / step) * step, 0, 255);
  return (quantize(red) << 16) | (quantize(green) << 8) | quantize(blue);
};
const unpack = (color: number): Rgb => [
  (color >> 16) & 255,
  (color >> 8) & 255,
  color & 255,
];
const blendColor = (first: number, second: number, amount: number) => {
  const a = unpack(first);
  const b = unpack(second);
  return pack(
    mix(a[0], b[0], amount),
    mix(a[1], b[1], amount),
    mix(a[2], b[2], amount),
    8
  );
};
const luminance = (color: Rgb) =>
  color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722;
const colorDistance = (first: Rgb, second: Rgb) =>
  (first[0] - second[0]) ** 2 +
  (first[1] - second[1]) ** 2 +
  (first[2] - second[2]) ** 2;
const average = (colors: readonly Rgb[]): Rgb => {
  if (colors.length === 0) return [0, 0, 0];
  const total = colors.reduce(
    (sum, color) => [sum[0] + color[0], sum[1] + color[1], sum[2] + color[2]],
    [0, 0, 0]
  );
  return [
    total[0] / colors.length,
    total[1] / colors.length,
    total[2] / colors.length,
  ];
};
const hex = (value: number) =>
  clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0");
const rgbHex = (color: Rgb) =>
  `#${hex(color[0])}${hex(color[1])}${hex(color[2])}`;

const BITMAPS: Record<string, string> = {
  " ": "00000/00000/00000/00000/00000/00000/00000",
  ".": "00000/00000/00000/00000/00000/00100/00100",
  ":": "00000/00100/00100/00000/00100/00100/00000",
  "-": "00000/00000/00000/11111/00000/00000/00000",
  _: "00000/00000/00000/00000/00000/00000/11111",
  "|": "00100/00100/00100/00100/00100/00100/00100",
  "/": "00001/00010/00010/00100/01000/01000/10000",
  "\\": "10000/01000/01000/00100/00010/00010/00001",
  "+": "00000/00100/00100/11111/00100/00100/00000",
  "*": "00000/10101/01110/11111/01110/10101/00000",
  x: "00000/10001/01010/00100/01010/10001/00000",
  "<": "00010/00100/01000/10000/01000/00100/00010",
  ">": "01000/00100/00010/00001/00010/00100/01000",
  "(": "00010/00100/01000/01000/01000/00100/00010",
  ")": "01000/00100/00010/00010/00010/00100/01000",
  "[": "01110/01000/01000/01000/01000/01000/01110",
  "]": "01110/00010/00010/00010/00010/00010/01110",
  "^": "00100/01010/10001/00000/00000/00000/00000",
  v: "00000/00000/00000/00000/10001/01010/00100",
  A: "01110/10001/10001/11111/10001/10001/10001",
  C: "01111/10000/10000/10000/10000/10000/01111",
  J: "00001/00001/00001/00001/10001/10001/01110",
  L: "10000/10000/10000/10000/10000/10000/11111",
  M: "10001/11011/10101/10101/10001/10001/10001",
  O: "01110/10001/10001/10001/10001/10001/01110",
  T: "11111/00100/00100/00100/00100/00100/00100",
  U: "10001/10001/10001/10001/10001/10001/01110",
  V: "10001/10001/10001/10001/10001/01010/00100",
  W: "10001/10001/10001/10101/10101/11011/10001",
  X: "10001/10001/01010/00100/01010/10001/10001",
  Y: "10001/10001/01010/00100/00100/00100/00100",
  "0": "01110/10011/10101/10101/11001/10001/01110",
  "1": "00100/01100/00100/00100/00100/00100/01110",
  "=": "00000/11111/00000/11111/00000/00000/00000",
  "%": "11001/11010/00100/01000/10110/00110/00000",
  "#": "01010/11111/01010/01010/11111/01010/00000",
  "@": "11111/11111/11111/11111/11111/11111/11111",
};

const glyphs: Glyph[] = Object.entries(BITMAPS).map(([char, rows]) => {
  const bitmap = rows.split("/");
  const vector: number[] = [];
  const xBounds = [0, 3, 5];
  const yBounds = [0, 2, 5, 7];
  for (let regionY = 0; regionY < 3; regionY++) {
    for (let regionX = 0; regionX < 2; regionX++) {
      let ink = 0;
      let area = 0;
      for (let y = yBounds[regionY]!; y < yBounds[regionY + 1]!; y++) {
        for (let x = xBounds[regionX]!; x < xBounds[regionX + 1]!; x++) {
          ink += bitmap[y]![x] === "1" ? 1 : 0;
          area++;
        }
      }
      vector.push(Math.min(1, (ink / area) * 3));
    }
  }
  return { char, vector };
});

const blankCells = (width: number, height: number, background = 0): Cell[] =>
  Array.from({ length: width * height }, () => ({
    char: " ",
    foreground: background,
    background,
  }));
const setCell = (
  cells: Cell[],
  width: number,
  height: number,
  x: number,
  y: number,
  char: string,
  foreground: number,
  background = 0
) => {
  const column = Math.round(x);
  const row = Math.round(y);
  if (column < 0 || column >= width || row < 0 || row >= height) return;
  cells[row * width + column] = { char, foreground, background };
};
const drawText = (
  cells: Cell[],
  width: number,
  height: number,
  x: number,
  y: number,
  text: string,
  foreground: number,
  background = 0
) => {
  [...text].forEach((char, index) =>
    setCell(cells, width, height, x + index, y, char, foreground, background)
  );
};
const drawActLabel = (
  cells: Cell[],
  width: number,
  height: number,
  number: number,
  name: string
) =>
  drawText(
    cells,
    width,
    height,
    2,
    1,
    `0${number} / ${name}`,
    pack(58, 68, 92, 8)
  );

class TerminalPainter {
  private previous: string[] = [];

  invalidate() {
    this.previous = [];
  }

  frame(cells: Cell[], width: number, height: number, cursor?: Cursor) {
    assert.equal(cells.length, width * height);
    const next = cells.map(
      (cell) =>
        `${cell.char}\0${cell.foreground}\0${cell.background}\0${cell.indexed ? 1 : 0}`
    );
    const parts = [`${CSI}?2026h`];
    let currentStyle = "";
    for (let row = 0; row < height; row++) {
      let column = 0;
      while (column < width) {
        const index = row * width + column;
        if (next[index] === this.previous[index]) {
          column++;
          continue;
        }
        parts.push(`${CSI}${row + 1};${column + 1}H`);
        while (column < width) {
          const cellIndex = row * width + column;
          if (column > 0 && next[cellIndex] === this.previous[cellIndex]) break;
          const cell = cells[cellIndex]!;
          const foreground = unpack(cell.foreground);
          const background = unpack(cell.background);
          const style = cell.indexed
            ? `${CSI}38;5;${cell.foreground};48;5;${cell.background}m`
            : `${CSI}38;2;${foreground[0]};${foreground[1]};${foreground[2]};48;2;${background[0]};${background[1]};${background[2]}m`;
          if (style !== currentStyle) {
            parts.push(style);
            currentStyle = style;
          }
          parts.push(cell.char);
          column++;
          if (column >= width) break;
          const following = row * width + column;
          if (next[following] === this.previous[following]) break;
        }
      }
    }
    if (cursor) {
      parts.push(
        `${CSI}${cursor.style} q${CSI}${cursor.y + 1};${cursor.x + 1}H${CSI}?25h`
      );
    } else {
      parts.push(`${CSI}?25l`);
    }
    parts.push(`${CSI}0m${CSI}?2026l`);
    this.previous = next;
    return parts.join("");
  }
}

class InkField {
  readonly cyan: Float32Array;
  readonly magenta: Float32Array;
  private nextCyan: Float32Array;
  private nextMagenta: Float32Array;

  constructor(
    readonly width: number,
    readonly height: number
  ) {
    this.cyan = new Float32Array(width * height);
    this.magenta = new Float32Array(width * height);
    this.nextCyan = new Float32Array(width * height);
    this.nextMagenta = new Float32Array(width * height);
  }

  private sample(field: Float32Array, x: number, y: number) {
    const safeX = clamp(x, 0, this.width - 1);
    const safeY = clamp(y, 0, this.height - 1);
    const x0 = Math.floor(safeX);
    const y0 = Math.floor(safeY);
    const x1 = Math.min(this.width - 1, x0 + 1);
    const y1 = Math.min(this.height - 1, y0 + 1);
    const fractionX = safeX - x0;
    const fractionY = safeY - y0;
    return (
      mix(
        field[y0 * this.width + x0]!,
        field[y0 * this.width + x1]!,
        fractionX
      ) *
        (1 - fractionY) +
      mix(
        field[y1 * this.width + x0]!,
        field[y1 * this.width + x1]!,
        fractionX
      ) *
        fractionY
    );
  }

  deposit(x: number, y: number, cyan: number, magenta: number) {
    for (let offsetY = -3; offsetY <= 3; offsetY++) {
      for (let offsetX = -4; offsetX <= 4; offsetX++) {
        const column = Math.round(x + offsetX);
        const row = Math.round(y + offsetY);
        if (column < 0 || column >= this.width || row < 0 || row >= this.height)
          continue;
        const weight = Math.exp(
          -(offsetX * offsetX * 0.3 + offsetY * offsetY * 0.55)
        );
        const index = row * this.width + column;
        this.cyan[index] = Math.min(1, this.cyan[index]! + cyan * weight);
        this.magenta[index] = Math.min(
          1,
          this.magenta[index]! + magenta * weight
        );
      }
    }
  }

  step(delta: number, time: number) {
    const dt = clamp(delta, 0, 0.08);
    const centerX = this.width * (0.5 + Math.sin(time * 0.37) * 0.08);
    const centerY = this.height * 0.68;
    const decay = Math.exp(-dt * 0.46);
    for (let row = 0; row < this.height; row++) {
      for (let column = 0; column < this.width; column++) {
        const dx = column - centerX;
        const dy = row - centerY;
        const radius = Math.max(8, Math.hypot(dx, dy));
        const velocityX =
          (-dy / radius) * 5.2 + Math.sin(row * 0.31 + time * 1.7) * 1.5;
        const velocityY =
          (dx / radius) * 2.4 - 1.2 + Math.sin(column * 0.17 - time) * 0.8;
        const index = row * this.width + column;
        this.nextCyan[index] =
          this.sample(
            this.cyan,
            column - velocityX * dt,
            row - velocityY * dt
          ) * decay;
        this.nextMagenta[index] =
          this.sample(
            this.magenta,
            column - velocityX * dt,
            row - velocityY * dt
          ) * decay;
      }
    }
    this.cyan.set(this.nextCyan);
    this.magenta.set(this.nextMagenta);
  }

  color(index: number) {
    return pack(
      16 + this.magenta[index]! * 225,
      12 + this.cyan[index]! * 200,
      28 + this.cyan[index]! * 220 + this.magenta[index]! * 75,
      8
    );
  }

  energy() {
    let total = 0;
    for (let index = 0; index < this.cyan.length; index++)
      total += this.cyan[index]! + this.magenta[index]!;
    return total;
  }
}

const dampedSpring = (time: number, damping = 0.42, frequency = 7.5) => {
  if (time <= 0) return 0;
  const root = Math.sqrt(1 - damping * damping);
  const damped = frequency * root;
  return (
    1 -
    Math.exp(-damping * frequency * time) *
      (Math.cos(damped * time) + (damping / root) * Math.sin(damped * time))
  );
};

const firstAct = (time: number, width: number, height: number) => {
  const background = pack(2, 3, 9, 8);
  const cells = blankCells(width, height, background);
  const prompt = "> first light";
  const startX = Math.max(2, Math.floor((width - prompt.length) / 2));
  const row = Math.floor(height * 0.46);
  const count = clamp(Math.floor((time - 0.55) / 0.19), 0, prompt.length);
  for (let y = 2; y < height - 2; y++) {
    for (let x = 0; x < width; x++) {
      let glow = 0;
      for (let event = Math.max(0, count - 5); event < count; event++) {
        const age = time - (0.55 + event * 0.19);
        if (age < 0 || age > 1.8) continue;
        const distance = Math.hypot(x - (startX + event), (y - row) * 1.8);
        const wave = Math.exp(-Math.abs(distance - age * 11) * 1.25);
        glow = Math.max(glow, wave * Math.exp(-age * 0.9));
      }
      if (glow > 0.08) {
        const value = pack(20 + glow * 40, 30 + glow * 100, 60 + glow * 190, 8);
        setCell(
          cells,
          width,
          height,
          x,
          y,
          glow > 0.48 ? "*" : "·",
          value,
          background
        );
      }
    }
  }
  drawText(
    cells,
    width,
    height,
    startX,
    row,
    prompt.slice(0, count),
    pack(188, 226, 255, 8),
    background
  );
  drawActLabel(cells, width, height, 1, "CURSOR");
  const style: Cursor["style"] = time < 1.35 ? 5 : time < 2.35 ? 3 : 1;
  return {
    cells,
    cursor: { x: startX + count, y: row, style } satisfies Cursor,
  };
};

const inkAct = (
  time: number,
  delta: number,
  width: number,
  height: number,
  ink: InkField,
  deposited: Uint8Array
) => {
  ink.step(delta, time);
  const background = pack(2, 3, 9, 8);
  const cells = blankCells(width, height, background);
  const phrase = "FIRST LIGHT";
  const startX = Math.floor((width - phrase.length) / 2);
  const startY = Math.floor(height * 0.3);
  const waterY = Math.floor(height * 0.7);
  for (let index = 0; index < phrase.length; index++) {
    const char = phrase[index]!;
    if (char === " ") continue;
    const localTime = time - index * 0.085;
    const progress = dampedSpring(localTime, 0.36, 6.7);
    const x = startX + index + Math.sin(localTime * 2.2 + index) * 0.35;
    const y = mix(startY, waterY, progress);
    if (localTime >= 1.05 && !deposited[index]) {
      ink.deposit(x, waterY, index % 2 ? 0.9 : 0.25, index % 2 ? 0.25 : 0.9);
      deposited[index] = 1;
    }
    if (localTime < 1.7)
      setCell(
        cells,
        width,
        height,
        x,
        y,
        char,
        index % 2 ? pack(255, 92, 205) : pack(72, 229, 255),
        background
      );
  }
  const densityGlyphs = [" ", ".", "·", ":", "*", "#"];
  for (let index = 0; index < ink.cyan.length; index++) {
    const density = clamp(ink.cyan[index]! + ink.magenta[index]!, 0, 1);
    if (density < 0.025) continue;
    const glyph =
      densityGlyphs[Math.floor(density * (densityGlyphs.length - 1))]!;
    const existing = cells[index]!;
    if (existing.char !== " ") continue;
    cells[index] = {
      char: glyph,
      foreground: ink.color(index),
      background,
    };
  }
  drawActLabel(cells, width, height, 2, "CHARACTER");
  return cells;
};

const SHADER = /* wgsl */ `
struct Uniforms { time: f32, width: f32, height: f32, energy: f32 };
@group(0) @binding(0) var<uniform> u: Uniforms;

@vertex
fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let corners = array(vec2f(-1.0, -3.0), vec2f(3.0, 1.0), vec2f(-1.0, 1.0));
  return vec4f(corners[index], 0.0, 1.0);
}

fn rotY(angle: f32) -> mat3x3f {
  return mat3x3f(
    vec3f(cos(angle), 0.0, sin(angle)),
    vec3f(0.0, 1.0, 0.0),
    vec3f(-sin(angle), 0.0, cos(angle))
  );
}

fn rotX(angle: f32) -> mat3x3f {
  return mat3x3f(
    vec3f(1.0, 0.0, 0.0),
    vec3f(0.0, cos(angle), -sin(angle)),
    vec3f(0.0, sin(angle), cos(angle))
  );
}

fn sdRoundBox(p: vec3f, bounds: vec3f, radius: f32) -> f32 {
  let q = abs(p) - bounds + radius;
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0) - radius;
}

fn sdTorus(p: vec3f, radii: vec2f) -> f32 {
  let q = vec2f(length(p.xz) - radii.x, p.y);
  return length(q) - radii.y;
}

fn scene(p: vec3f) -> vec2f {
  let turn = rotY(u.time * 0.24) * rotX(sin(u.time * 0.31) * 0.12);
  let local = turn * p;
  let monolith = sdRoundBox(local, vec3f(0.62, 1.18, 0.23), 0.09);
  let ringA = sdTorus(rotX(1.18) * p, vec2f(1.22, 0.028));
  let ringB = sdTorus(rotX(-0.92) * rotY(0.7) * p, vec2f(1.45, 0.018));
  let rings = min(ringA, ringB);
  if (monolith < rings) { return vec2f(monolith, 1.0); }
  return vec2f(rings, 2.0);
}

fn hash(point: vec2f) -> f32 {
  return fract(sin(dot(point, vec2f(127.1, 311.7))) * 43758.5453);
}

fn normalAt(p: vec3f) -> vec3f {
  let e = vec2f(0.0015, 0.0);
  return normalize(vec3f(
    scene(p + e.xyy).x - scene(p - e.xyy).x,
    scene(p + e.yxy).x - scene(p - e.yxy).x,
    scene(p + e.yyx).x - scene(p - e.yyx).x
  ));
}

@fragment
fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let resolution = vec2f(u.width, u.height);
  var uv = (position.xy * 2.0 - resolution) / resolution.y;
  uv.y = -uv.y;
  let orbit = sin(u.time * 0.16) * 0.34;
  let ro = vec3f(orbit, sin(u.time * 0.23) * 0.12, -4.1);
  let lookAt = vec3f(0.0, 0.0, 0.0);
  let forward = normalize(lookAt - ro);
  let right = normalize(cross(forward, vec3f(0.0, 1.0, 0.0)));
  let up = cross(right, forward);
  let rd = normalize(forward * 1.8 + right * uv.x + up * uv.y);

  let cloud = 0.5 + 0.5 * sin(uv.x * 3.1 + sin(uv.y * 4.7 - u.time * 0.23));
  let haze = exp(-abs(uv.y + sin(uv.x * 1.8 + u.time * 0.18) * 0.22) * 3.4);
  let starCell = floor((uv + vec2f(u.time * 0.006, 0.0)) * 74.0);
  let stars = select(0.0, pow(hash(starCell), 18.0), hash(starCell) > 0.965);
  var color = mix(vec3f(0.008, 0.012, 0.038), vec3f(0.055, 0.012, 0.11), cloud * 0.55);
  color += haze * vec3f(0.015, 0.08, 0.12) * (0.55 + u.energy * 0.75);
  color += stars * vec3f(0.5, 0.72, 1.0);

  var distance = 0.0;
  var material = 0.0;
  var hit = false;
  for (var step = 0; step < 96; step++) {
    let sample = scene(ro + rd * distance);
    if (sample.x < 0.0012) {
      material = sample.y;
      hit = true;
      break;
    }
    distance += sample.x;
    if (distance > 9.0) { break; }
  }

  if (hit) {
    let p = ro + rd * distance;
    let normal = normalAt(p);
    let light = normalize(vec3f(-0.45, 0.78, -0.55));
    let diffuse = max(dot(normal, light), 0.0);
    let fresnel = pow(1.0 - max(dot(normal, -rd), 0.0), 3.0);
    if (material < 1.5) {
      let local = rotY(u.time * 0.24) * rotX(sin(u.time * 0.31) * 0.12) * p;
      let scan = pow(0.5 + 0.5 * sin(local.y * 24.0 - u.time * 3.2), 18.0);
      let runes = pow(0.5 + 0.5 * sin(local.x * 18.0 + floor(local.y * 8.0) * 2.7), 24.0);
      let base = mix(vec3f(0.035, 0.045, 0.09), vec3f(0.16, 0.04, 0.2), fresnel);
      color = base * (0.18 + diffuse * 0.82);
      color += (scan + runes * 0.55) * vec3f(0.08, 0.72, 1.0) * (0.7 + u.energy);
      color += fresnel * vec3f(0.4, 0.12, 0.7);
    } else {
      let pulse = 0.6 + 0.4 * sin(u.time * 2.4 - distance * 3.0);
      color = vec3f(0.08, 0.55, 1.0) * (1.2 + u.energy) * pulse;
      color += vec3f(0.8, 0.1, 0.7) * fresnel;
    }
    color = mix(color, vec3f(0.01, 0.02, 0.06), smoothstep(5.0, 8.5, distance));
  }
  return vec4f(pow(color, vec3f(0.4545)), 1.0);
}
`;

class GpuScene {
  private constructor(
    readonly width: number,
    readonly height: number,
    readonly bytesPerRow: number,
    readonly adapterName: string,
    private readonly device: GPUDevice,
    private readonly target: GPUTexture,
    private readonly uniforms: GPUBuffer,
    private readonly readback: GPUBuffer,
    private readonly pipeline: GPURenderPipeline,
    private readonly bindGroup: GPUBindGroup
  ) {}

  static async create(width: number, height: number) {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("FIRST LIGHT requires a WebGPU adapter");
    const device = await adapter.requestDevice();
    const module = device.createShaderModule({ code: SHADER });
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const target = device.createTexture({
      size: { width, height },
      format: "rgba8unorm",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const uniforms = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const readback = device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: {
        module,
        entryPoint: "fs",
        targets: [{ format: "rgba8unorm" }],
      },
    });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniforms } }],
    });
    return new GpuScene(
      width,
      height,
      bytesPerRow,
      adapter.info?.description ?? "WebGPU",
      device,
      target,
      uniforms,
      readback,
      pipeline,
      bindGroup
    );
  }

  async render(time: number, energy: number) {
    this.device.queue.writeBuffer(
      this.uniforms,
      0,
      new Float32Array([time, this.width, this.height, energy])
    );
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.target.createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3);
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: this.target },
      {
        buffer: this.readback,
        bytesPerRow: this.bytesPerRow,
        rowsPerImage: this.height,
      },
      { width: this.width, height: this.height }
    );
    this.device.queue.submit([encoder.finish()]);
    await this.readback.mapAsync(GPUMapMode.READ);
    const pixels = new Uint8Array(this.readback.getMappedRange().slice(0));
    this.readback.unmap();
    return pixels;
  }
}

const pixelAverage = (
  pixels: Uint8Array,
  bytesPerRow: number,
  x: number,
  y: number,
  width: number,
  height: number
): Rgb => {
  let red = 0;
  let green = 0;
  let blue = 0;
  let count = 0;
  for (let row = y; row < y + height; row++) {
    for (let column = x; column < x + width; column++) {
      const offset = row * bytesPerRow + column * 4;
      red += pixels[offset]!;
      green += pixels[offset + 1]!;
      blue += pixels[offset + 2]!;
      count++;
    }
  }
  return [red / count, green / count, blue / count];
};

const splitColors = (samples: readonly Rgb[]) => {
  let first = samples[0]!;
  let second = samples.at(-1)!;
  let farthest = -1;
  for (const left of samples) {
    for (const right of samples) {
      const distance = colorDistance(left, right);
      if (distance > farthest) {
        farthest = distance;
        first = left;
        second = right;
      }
    }
  }
  for (let pass = 0; pass < 3; pass++) {
    const firstGroup: Rgb[] = [];
    const secondGroup: Rgb[] = [];
    for (const sample of samples) {
      if (colorDistance(sample, first) <= colorDistance(sample, second))
        firstGroup.push(sample);
      else secondGroup.push(sample);
    }
    if (firstGroup.length) first = average(firstGroup);
    if (secondGroup.length) second = average(secondGroup);
  }
  if (luminance(first) > luminance(second)) [first, second] = [second, first];
  const axis: Rgb = [
    second[0] - first[0],
    second[1] - first[1],
    second[2] - first[2],
  ];
  const magnitude = Math.max(1, axis[0] ** 2 + axis[1] ** 2 + axis[2] ** 2);
  const values = samples.map((sample) =>
    clamp(
      ((sample[0] - first[0]) * axis[0] +
        (sample[1] - first[1]) * axis[1] +
        (sample[2] - first[2]) * axis[2]) /
        magnitude,
      0,
      1
    )
  );
  return { low: first, high: second, values, distance: farthest };
};

class ShapeHistory {
  readonly glyph: Int16Array;
  readonly inverted: Uint8Array;

  constructor(size: number) {
    this.glyph = new Int16Array(size);
    this.glyph.fill(-1);
    this.inverted = new Uint8Array(size);
  }
}

const vectorError = (
  target: readonly number[],
  candidate: readonly number[],
  inverted: boolean
) => {
  let error = 0;
  for (let index = 0; index < target.length; index++) {
    const value = inverted ? 1 - candidate[index]! : candidate[index]!;
    error += (target[index]! - value) ** 2;
  }
  return error;
};

const shapeCells = (
  pixels: Uint8Array,
  bytesPerRow: number,
  width: number,
  height: number,
  history: ShapeHistory,
  monochrome: boolean
) => {
  const cells: Cell[] = [];
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const samples: Rgb[] = [];
      for (let regionY = 0; regionY < 3; regionY++) {
        for (let regionX = 0; regionX < 2; regionX++) {
          samples.push(
            pixelAverage(
              pixels,
              bytesPerRow,
              column * 4 + regionX * 2,
              row * 6 + regionY * 2,
              2,
              2
            )
          );
        }
      }
      const split = splitColors(samples);
      if (split.distance < 110) {
        const color = pack(...average(samples), monochrome ? 24 : 12);
        cells.push({ char: " ", foreground: color, background: color });
        continue;
      }
      let bestGlyph = 0;
      let bestInverted = false;
      let bestError = Number.POSITIVE_INFINITY;
      for (let glyphIndex = 0; glyphIndex < glyphs.length; glyphIndex++) {
        for (const inverted of [false, true]) {
          const error = vectorError(
            split.values,
            glyphs[glyphIndex]!.vector,
            inverted
          );
          if (error < bestError) {
            bestError = error;
            bestGlyph = glyphIndex;
            bestInverted = inverted;
          }
        }
      }
      const cellIndex = row * width + column;
      const previousGlyph = history.glyph[cellIndex]!;
      if (previousGlyph >= 0) {
        const previousInverted = Boolean(history.inverted[cellIndex]);
        const previousError = vectorError(
          split.values,
          glyphs[previousGlyph]!.vector,
          previousInverted
        );
        if (previousError <= bestError + 0.16) {
          bestGlyph = previousGlyph;
          bestInverted = previousInverted;
        }
      }
      history.glyph[cellIndex] = bestGlyph;
      history.inverted[cellIndex] = bestInverted ? 1 : 0;
      let low = pack(...split.low, monochrome ? 24 : 12);
      let high = pack(...split.high, monochrome ? 24 : 12);
      if (monochrome) {
        const lowLight = luminance(split.low);
        const highLight = luminance(split.high);
        low = pack(lowLight * 0.12, lowLight * 0.18, lowLight * 0.27, 12);
        high = pack(highLight * 0.68, highLight * 0.84, highLight, 12);
      }
      cells.push({
        char: glyphs[bestGlyph]!.char,
        foreground: bestInverted ? low : high,
        background: bestInverted ? high : low,
      });
    }
  }
  return cells;
};

const quadrantCells = (
  pixels: Uint8Array,
  bytesPerRow: number,
  width: number,
  height: number
) => {
  const cells: Cell[] = [];
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const samples = [
        pixelAverage(pixels, bytesPerRow, column * 4, row * 6, 2, 3),
        pixelAverage(pixels, bytesPerRow, column * 4 + 2, row * 6, 2, 3),
        pixelAverage(pixels, bytesPerRow, column * 4, row * 6 + 3, 2, 3),
        pixelAverage(pixels, bytesPerRow, column * 4 + 2, row * 6 + 3, 2, 3),
      ];
      const split = splitColors(samples);
      let mask = 0;
      split.values.forEach((value, index) => {
        if (value >= 0.5) mask |= 1 << index;
      });
      cells.push({
        char: QUADRANTS[mask]!,
        foreground: pack(...split.high, 12),
        background: pack(...split.low, 12),
      });
    }
  }
  return cells;
};

const paletteIndex = (color: Rgb) =>
  16 + clamp(Math.floor((luminance(color) / 256) * 16), 0, 15);
const halfBlockCells = (
  pixels: Uint8Array,
  bytesPerRow: number,
  width: number,
  height: number,
  indexed: boolean
) => {
  const cells: Cell[] = [];
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const top = pixelAverage(pixels, bytesPerRow, column * 4, row * 6, 4, 3);
      const bottom = pixelAverage(
        pixels,
        bytesPerRow,
        column * 4,
        row * 6 + 3,
        4,
        3
      );
      cells.push(
        indexed
          ? {
              char: "▀",
              foreground: paletteIndex(top),
              background: paletteIndex(bottom),
              indexed: true,
            }
          : {
              char: "▀",
              foreground: pack(...top, 8),
              background: pack(...bottom, 8),
            }
      );
    }
  }
  return cells;
};

const overlayInk = (cells: Cell[], ink: InkField, amount: number) => {
  for (let index = 0; index < cells.length; index++) {
    const density =
      clamp(ink.cyan[index]! + ink.magenta[index]!, 0, 1) * amount;
    if (density <= 0) continue;
    const color = ink.color(index);
    cells[index]!.foreground = blendColor(
      cells[index]!.foreground,
      color,
      density
    );
    cells[index]!.background = blendColor(
      cells[index]!.background,
      color,
      density * 0.55
    );
  }
};

const finalAct = (time: number, width: number, height: number) => {
  const background = pack(2, 3, 9, 8);
  const cells = blankCells(width, height, background);
  const prompt = "> first light: ready";
  const count = clamp(Math.floor(time / 0.085), 0, prompt.length);
  const x = Math.max(2, Math.floor((width - prompt.length) / 2));
  const y = Math.floor(height * 0.5);
  drawText(
    cells,
    width,
    height,
    x,
    y,
    prompt.slice(0, count),
    pack(126, 255, 191, 8),
    background
  );
  drawActLabel(cells, width, height, 5, "RETURN");
  return {
    cells,
    cursor: { x: x + count, y, style: 5 } satisfies Cursor,
  };
};

const palette = (time: number) => {
  const pairs = PALETTE_INDICES.flatMap((index, offset) => {
    const phase = offset * 0.29 - time * 2.4;
    const color: Rgb = [
      110 + 105 * Math.sin(phase),
      105 + 100 * Math.sin(phase + 2.1),
      145 + 110 * Math.sin(phase + 4.2),
    ];
    return [index, rgbHex(color)];
  });
  return `${ESC}]4;${pairs.join(";")}${ST}`;
};
const resetPalette = `${ESC}]104;${PALETTE_INDICES.join(";")}${ST}`;
const terminalCleanup = () =>
  `${ESC}]111${ST}${ESC}]112${ST}${resetPalette}${CSI}r${CSI}0 q${CSI}0m${CSI}?7h${CSI}?25h${CSI}?1049l`;

const valueAfter = (flag: string, fallback: number) => {
  const index = process.argv.indexOf(flag);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`${flag} must be a positive number`);
  return value;
};

if (process.argv.includes("--list")) {
  console.log(
    "0–4s   CURSOR     OSC color + native cursor morph + key ripples"
  );
  console.log("4–10s  CHARACTER  damped-spring letters + advected ink");
  console.log("10–19s CELL       shape-aware ASCII + temporal hysteresis");
  console.log("19–28s PIXEL      ASCII → quadrant → OSC 4 → truecolor GPU");
  console.log("28–34s RETURN     reverse ladder + bounded scroll + prompt");
  process.exit(0);
}

const check = process.argv.includes("--check") || !process.stdout.isTTY;
const checkWidth = 28;
const checkHeight = 14;
const terminalWidth = process.stdout.columns ?? 100;
const terminalHeight = process.stdout.rows ?? 32;
if (!check && (terminalWidth < 20 || terminalHeight < 12)) {
  console.error("FIRST LIGHT requires a terminal of at least 20x12 cells.");
  process.exit(1);
}
const outputWidth = check ? checkWidth : Math.min(terminalWidth, 120);
const outputHeight = check ? checkHeight : Math.min(terminalHeight, 42);
const gpu = await GpuScene.create(outputWidth * 4, outputHeight * 6);

if (check) {
  const pixels = await gpu.render(7.5, 0.8);
  const history = new ShapeHistory(checkWidth * checkHeight);
  const ascii = shapeCells(
    pixels,
    gpu.bytesPerRow,
    checkWidth,
    checkHeight,
    history,
    false
  );
  const quadrant = quadrantCells(
    pixels,
    gpu.bytesPerRow,
    checkWidth,
    checkHeight
  );
  const half = halfBlockCells(
    pixels,
    gpu.bytesPerRow,
    checkWidth,
    checkHeight,
    false
  );
  const indexed = halfBlockCells(
    pixels,
    gpu.bytesPerRow,
    checkWidth,
    checkHeight,
    true
  );
  const ink = new InkField(checkWidth, checkHeight);
  ink.deposit(checkWidth / 2, checkHeight / 2, 1, 0.4);
  for (let step = 0; step < 20; step++) ink.step(1 / 30, step / 30);
  assert.equal(ascii.length, checkWidth * checkHeight);
  assert.ok(new Set(ascii.map((cell) => cell.char)).size > 5);
  assert.ok(quadrant.some((cell) => cell.char !== " "));
  assert.ok(half.every((cell) => cell.char === "▀"));
  assert.ok(indexed.every((cell) => cell.indexed));
  assert.ok(ink.energy() > 1);
  assert.ok(dampedSpring(0.8) > 0.9);
  const painter = new TerminalPainter();
  assert.match(painter.frame(ascii, checkWidth, checkHeight), /\x1b\[\?2026h/);
  assert.match(palette(1), /\x1b\]4;16;#[0-9a-f]{6}/);
  assert.match(terminalCleanup(), /\x1b\]111/);
  console.log(
    `FIRST LIGHT self-check passed: ${gpu.adapterName}, shape ASCII, quadrants, half-blocks, OSC palette, springs, ink, and synchronized diffs.`
  );
  process.exit(0);
}

const duration = valueAfter("--seconds", STORY_SECONDS);
const fps = valueAfter("--fps", 30);
const output = process.stdout;
const input = process.stdin;
const painter = new TerminalPainter();
const ink = new InkField(outputWidth, outputHeight);
const deposited = new Uint8Array("FIRST LIGHT".length);
const history = new ShapeHistory(outputWidth * outputHeight);
let stopped = false;
let backgroundActive = false;
let paletteActive = false;
let scrollStep = -1;
let inputPulse = 0;

const cleanup = () => {
  if (stopped) return;
  stopped = true;
  if (input.isTTY) {
    input.setRawMode(false);
    input.pause();
  }
  output.write(terminalCleanup());
};
const onInput = (chunk: Buffer) => {
  const key = chunk.toString();
  if (key === "\x1b" || key.includes("\x03") || key.toLowerCase().includes("q"))
    cleanup();
  else inputPulse = 1;
};
process.once("SIGHUP", cleanup);
process.once("SIGINT", cleanup);
process.once("SIGQUIT", cleanup);
process.once("SIGTERM", cleanup);
process.once("uncaughtException", (error) => {
  cleanup();
  console.error(error);
  process.exitCode = 1;
});

if (input.isTTY) {
  input.setRawMode(true);
  input.resume();
  input.on("data", onInput);
}
output.write(`${CSI}?1049h${CSI}?7l${CSI}2J${CSI}H${CSI}?25l`);

const started = performance.now();
let previousRealTime = started;
let frameNumber = 0;
while (!stopped) {
  if (
    (output.columns ?? outputWidth) < outputWidth ||
    (output.rows ?? outputHeight) < outputHeight
  )
    break;
  const now = performance.now();
  const elapsed = (now - started) / 1000;
  if (elapsed >= duration) break;
  const storyTime = (elapsed / duration) * STORY_SECONDS;
  const realDelta = (now - previousRealTime) / 1000;
  const storyDelta = realDelta * (STORY_SECONDS / duration);
  previousRealTime = now;
  inputPulse *= Math.exp(-realDelta * 3.5);

  let cells: Cell[] | undefined;
  let cursor: Cursor | undefined;
  if (storyTime < 4) {
    const act = firstAct(storyTime, outputWidth, outputHeight);
    cells = act.cells;
    cursor = act.cursor;
    const background: Rgb = [
      2 + storyTime * 2,
      3 + Math.sin(storyTime * 1.4) * 2,
      9 + storyTime * 3.5,
    ];
    const cursorColor: Rgb = [
      90 + 150 * Math.sin(storyTime * 2.1) ** 2,
      150 + 100 * Math.sin(storyTime * 2.1 + 1) ** 2,
      255,
    ];
    output.write(
      `${ESC}]11;${rgbHex(background)}${ST}${ESC}]12;${rgbHex(cursorColor)}${ST}`
    );
    backgroundActive = true;
  } else if (storyTime < 10) {
    if (backgroundActive) {
      output.write(`${ESC}]111${ST}${ESC}]112${ST}`);
      backgroundActive = false;
    }
    cells = inkAct(
      storyTime - 4,
      storyDelta,
      outputWidth,
      outputHeight,
      ink,
      deposited
    );
  } else if (storyTime < 19) {
    ink.step(storyDelta, storyTime);
    const pixels = await gpu.render(storyTime - 10, 0.2 + inputPulse);
    cells = shapeCells(
      pixels,
      gpu.bytesPerRow,
      outputWidth,
      outputHeight,
      history,
      true
    );
    overlayInk(cells, ink, 1 - smoothstep(10, 13, storyTime));
    drawActLabel(cells, outputWidth, outputHeight, 3, "CELL");
  } else if (storyTime < 28) {
    const pixels = await gpu.render(storyTime - 10, 0.55 + inputPulse);
    if (storyTime < 21) {
      cells = shapeCells(
        pixels,
        gpu.bytesPerRow,
        outputWidth,
        outputHeight,
        history,
        false
      );
    } else if (storyTime < 23) {
      cells = quadrantCells(pixels, gpu.bytesPerRow, outputWidth, outputHeight);
    } else if (storyTime < 26) {
      cells = halfBlockCells(
        pixels,
        gpu.bytesPerRow,
        outputWidth,
        outputHeight,
        true
      );
      output.write(palette(storyTime));
      paletteActive = true;
    } else {
      if (paletteActive) {
        output.write(resetPalette);
        paletteActive = false;
        painter.invalidate();
      }
      cells = halfBlockCells(
        pixels,
        gpu.bytesPerRow,
        outputWidth,
        outputHeight,
        false
      );
    }
    drawActLabel(cells, outputWidth, outputHeight, 4, "PIXEL");
  } else if (storyTime < 31) {
    const pixels = await gpu.render(storyTime - 10, 0.35 + inputPulse);
    if (storyTime < 29)
      cells = halfBlockCells(
        pixels,
        gpu.bytesPerRow,
        outputWidth,
        outputHeight,
        false
      );
    else if (storyTime < 30)
      cells = quadrantCells(pixels, gpu.bytesPerRow, outputWidth, outputHeight);
    else
      cells = shapeCells(
        pixels,
        gpu.bytesPerRow,
        outputWidth,
        outputHeight,
        history,
        true
      );
    drawActLabel(cells, outputWidth, outputHeight, 5, "RETURN");
  } else if (storyTime < 32) {
    const nextScrollStep = Math.floor((storyTime - 31) * 12);
    if (nextScrollStep !== scrollStep) {
      if (scrollStep < 0) output.write(`${CSI}2;${outputHeight - 1}r`);
      output.write(`${CSI}${outputHeight - 1};1H${ESC}D`);
      scrollStep = nextScrollStep;
    }
  } else {
    if (scrollStep >= 0) {
      output.write(`${CSI}r${CSI}2J`);
      painter.invalidate();
      scrollStep = -1;
    }
    const act = finalAct(storyTime - 32, outputWidth, outputHeight);
    cells = act.cells;
    cursor = act.cursor;
    output.write(`${ESC}]12;#7effbf${ST}`);
  }

  if (stopped) break;
  if (cells)
    output.write(painter.frame(cells, outputWidth, outputHeight, cursor));
  frameNumber++;
  let target = started + (frameNumber * 1000) / fps;
  if (performance.now() - target > 1000 / fps) {
    frameNumber = Math.floor(((performance.now() - started) * fps) / 1000) + 1;
    target = started + (frameNumber * 1000) / fps;
  }
  const wait = target - performance.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}
cleanup();
