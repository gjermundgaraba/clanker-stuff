// Stream any ffmpeg-readable video or image as synchronized truecolor half
// blocks. ffmpeg owns decoding and scaling; this file only frames and blits.
//
// Run: node scripts/video-terminal.ts <media> [--fps 24] [--seconds 20]

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";

const ESC = "\x1b";
const out = process.stdout;

const ffmpegAvailable = () => {
  const result = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  return !result.error && result.status === 0;
};

const blit = (pixels: Uint8Array, width: number, height: number) => {
  assert.equal(pixels.length, width * height * 3);
  assert.equal(height % 2, 0);
  const parts = [`${ESC}[?2026h${ESC}[H`];
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x++) {
      const top = (y * width + x) * 3;
      const bottom = ((y + 1) * width + x) * 3;
      parts.push(
        `${ESC}[38;2;${pixels[top]};${pixels[top + 1]};${pixels[top + 2]};48;2;${pixels[bottom]};${pixels[bottom + 1]};${pixels[bottom + 2]}m▀`
      );
    }
    if (y + 2 < height) parts.push("\n");
  }
  parts.push(`${ESC}[0m${ESC}[?2026l`);
  return parts.join("");
};

if (process.argv.includes("--check")) {
  const frame = blit(Uint8Array.of(255, 0, 1, 2, 3, 254), 1, 2);
  assert.match(frame, /38;2;255;0;1;48;2;2;3;254m▀/);
  assert.ok(frame.startsWith(`${ESC}[?2026h${ESC}[H`));
  assert.ok(frame.endsWith(`${ESC}[0m${ESC}[?2026l`));
  console.log(
    `Video terminal self-check passed: half-block blitter OK; ffmpeg ${ffmpegAvailable() ? "available" : "not installed"}.`
  );
  process.exit(0);
}

const valueAfter = (flag: string, fallback: number) => {
  const index = process.argv.indexOf(flag);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`${flag} must be a positive number`);
  return value;
};

const media = process.argv.slice(2).find((value, index, values) => {
  const previous = values[index - 1];
  return (
    !value.startsWith("--") && previous !== "--fps" && previous !== "--seconds"
  );
});

if (!media) {
  console.error(
    "Usage: node scripts/video-terminal.ts <video-or-image> [--fps 24] [--seconds 20]"
  );
  process.exit(2);
}
if (!out.isTTY) {
  console.error("Video output requires an interactive truecolor terminal.");
  process.exit(1);
}
if (!ffmpegAvailable()) {
  console.error("ffmpeg was not found on PATH. Install ffmpeg and try again.");
  process.exit(1);
}

let fps: number;
let seconds: number;
try {
  fps = valueAfter("--fps", 24);
  seconds = valueAfter("--seconds", 20);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
}

const width = Math.max(1, out.columns ?? 80);
const rows = Math.max(1, (out.rows ?? 24) - 1);
const height = rows * 2;
const frameBytes = width * height * 3;
const ffmpeg = spawn(
  "ffmpeg",
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-stream_loop",
    "-1",
    "-i",
    media,
    "-t",
    String(seconds),
    "-an",
    "-sn",
    "-dn",
    "-vf",
    `fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    "-pix_fmt",
    "rgb24",
    "-f",
    "rawvideo",
    "pipe:1",
  ],
  { stdio: ["ignore", "pipe", "pipe"] }
);

let pending = Buffer.alloc(0);
let frame = 0;
let cancelled = false;
let stderr = "";
let stopped = false;
let started = 0;
const delay = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const cleanup = () => {
  if (stopped) return;
  stopped = true;
  out.write(`${ESC}[?2026l${ESC}[0m${ESC}[?25h${ESC}[?1049l`);
};
const cancel = () => {
  cancelled = true;
  ffmpeg.kill("SIGTERM");
  cleanup();
};

process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);
ffmpeg.stderr.setEncoding("utf8");
ffmpeg.stderr.on("data", (chunk: string) => {
  stderr = (stderr + chunk).slice(-4000);
});

let status: number | null = null;
try {
  out.write(`${ESC}[?1049h${ESC}[?25l`);
  for await (const chunk of ffmpeg.stdout) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (!stopped && pending.length >= frameBytes) {
      if (!started) started = performance.now();
      const target = started + (frame * 1000) / fps;
      const wait = target - performance.now();
      if (wait > 0) await delay(wait);
      if (stopped) break;
      out.write(blit(pending.subarray(0, frameBytes), width, height));
      pending = pending.subarray(frameBytes);
      frame++;
    }
  }

  status = await new Promise<number | null>((resolve) => {
    if (ffmpeg.exitCode !== null) resolve(ffmpeg.exitCode);
    else ffmpeg.once("close", resolve);
  });
} finally {
  cleanup();
}
if (!cancelled && (status !== 0 || frame === 0)) {
  console.error(
    status !== 0
      ? `ffmpeg failed${stderr.trim() ? `: ${stderr.trim()}` : "."}`
      : "ffmpeg produced no video frames."
  );
  process.exitCode = 1;
}
