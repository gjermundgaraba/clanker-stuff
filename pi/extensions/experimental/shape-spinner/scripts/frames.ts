import { geometry, project, TAU } from "./geometry.ts";

// Integer 20ms ticks preserve the 8s loop; Node truncates 1000/60 to 16ms.
export const FPS = 50;
export const SEED = "amp-orb";
export const STRIKES = [32, 64];
// Cached Amp web bright palette, not a claim about native callers' supplied Color.
const HUES = {
  blue: 250,
  purple: 300,
  pink: 345,
  red: 25,
  orange: 60,
  yellow: 90,
  green: 150,
  cyan: 205,
  gray: 0,
};
export const INKS = Object.fromEntries(
  Object.entries(HUES).map(([name, hue]) => [
    name,
    {
      dark: `oklch(84% ${name === "gray" ? 0 : 0.12} ${hue})`,
      light: `oklch(46% ${name === "gray" ? 0 : 0.18} ${hue})`,
    },
  ]),
);
// Fixed across every shape and pose. Keep perspective overflow without
// fitting individual frames, which would introduce artificial scale changes.
export const VIEWBOX = 32;

export function frame(shape: string, seconds: number, rest = false) {
  const g = geometry(SEED, shape);
  return {
    lines: project(g, rest ? 0 : (seconds / 8) * TAU, rest ? 1 : 0),
    strokeWidth: g.strokeWidth,
  };
}

// Self-contained so the build can execute this exact function in Chromium.
export function paint(
  canvas: Canvas,
  scene: ReturnType<typeof frame>,
  pixels: number,
  ink: string,
  viewbox: number,
) {
  canvas.width = canvas.height = pixels;
  const ctx = canvas.getContext("2d");
  const unit = pixels / viewbox;
  ctx.setTransform(unit, 0, 0, unit, pixels / 2 - 12 * unit, pixels / 2 - 12 * unit);
  ctx.strokeStyle = ink;
  ctx.lineWidth = scene.strokeWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const line of scene.lines) {
    ctx.globalAlpha = line.opacity;
    ctx.beginPath();
    ctx.moveTo(line.points[0][0], line.points[0][1]);
    for (const point of line.points.slice(1)) ctx.lineTo(point[0], point[1]);
    ctx.stroke();
  }
}

interface Canvas {
  width: number;
  height: number;
  getContext(kind: "2d"): {
    globalAlpha: number;
    strokeStyle: string;
    lineWidth: number;
    lineCap: string;
    lineJoin: string;
    setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
    beginPath(): void;
    moveTo(x: number, y: number): void;
    lineTo(x: number, y: number): void;
    stroke(): void;
  };
}
