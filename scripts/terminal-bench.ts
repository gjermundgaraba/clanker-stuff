// Terminal animation throughput benchmark, for calibrating the research doc's
// frame-rate guidance against this machine's Ghostty instead of a
// lowest-common-denominator terminal.
//
// Measures sustained pty write throughput (with backpressure respected) for:
//   1. full     — full-screen unique 24-bit colored frames
//   2. full+sync — the same wrapped in DECSET 2026 synchronized output
//   3. diff     — a 120-cell scattered update per frame (diff-renderer shape)
//
// Writes completing under backpressure ≈ the terminal consuming them; that is
// the practical ceiling for how fast an animation loop can feed this terminal.
// GPU-side render rate can be lower; watch the screen during "full" — visible
// tearing there but not in "full+sync" is the DECSET 2026 finding reproduced.
//
// Run: node scripts/terminal-bench.ts [--seconds 3]

import { once } from "node:events";

const ESC = "\x1b";
const out = process.stdout;
const isTTY = out.isTTY;
const cols = Math.max(1, out.columns ?? 120);
const rows = Math.max(1, (out.rows ?? 40) - 4);
const secondsArg = process.argv.indexOf("--seconds");
const seconds = secondsArg >= 0 ? Number(process.argv[secondsArg + 1]) : 3;
if (!Number.isFinite(seconds) || seconds <= 0) {
  throw new Error("--seconds must be a positive number");
}

const fullFrame = (frame: number) => {
  const parts: string[] = [`${ESC}[H`];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const r = (frame * 7 + row * 3 + col) % 256;
      const g = (frame * 5 + row * 5) % 256;
      const b = (frame * 3 + col * 2) % 256;
      parts.push(`${ESC}[38;2;${r};${g};${b}m▀`);
    }
    if (row < rows - 1) parts.push("\n");
  }
  parts.push(`${ESC}[0m`);
  return parts.join("");
};

const diffFrame = (frame: number) => {
  const parts: string[] = [];
  for (let index = 0; index < 120; index++) {
    const row = 1 + ((frame * 31 + index * 17) % rows);
    const col = 1 + ((frame * 13 + index * 29) % cols);
    const value = (frame + index * 9) % 256;
    parts.push(
      `${ESC}[${row};${col}H${ESC}[38;2;${value};${255 - value};128m█`
    );
  }
  parts.push(`${ESC}[0m`);
  return parts.join("");
};

// Piped runs measure frame generation only — discard instead of flooding the
// pipe with hundreds of MB of escape codes.
const write = isTTY
  ? async (payload: string) => {
      if (!out.write(payload)) await once(out, "drain");
    }
  : async (_payload: string) => {};

const bench = async (
  label: string,
  makeFrame: (frame: number) => string,
  sync: boolean
) => {
  let frame = 0;
  let bytes = 0;
  const started = performance.now();
  while (!stopped && performance.now() - started < seconds * 1000) {
    frame += 1;
    let payload = makeFrame(frame);
    if (sync) payload = `${ESC}[?2026h${payload}${ESC}[?2026l`;
    bytes += Buffer.byteLength(payload);
    await write(payload);
  }
  const elapsed = (performance.now() - started) / 1000;
  return {
    label,
    fps: frame / elapsed,
    mbps: bytes / elapsed / 1_000_000,
  };
};

let stopped = false;
let terminalActive = false;
const restore = () => {
  if (!terminalActive) return;
  terminalActive = false;
  out.write(`${ESC}[?2026l${ESC}[0m${ESC}[?25h${ESC}[?1049l`);
};
const interrupt = (exitCode: number) => {
  stopped = true;
  process.exitCode = exitCode;
  restore();
};
const onSigint = () => interrupt(130);
const onSigterm = () => interrupt(143);
process.once("SIGINT", onSigint);
process.once("SIGTERM", onSigterm);

if (!isTTY)
  console.log("warning: stdout is a pipe; results measure generation only");

const results: Awaited<ReturnType<typeof bench>>[] = [];
try {
  if (isTTY) {
    terminalActive = true;
    out.write(`${ESC}[?1049h${ESC}[?25l`);
  }
  for (const [label, makeFrame, sync] of [
    ["full        ", fullFrame, false],
    ["full + sync ", fullFrame, true],
    ["diff (120c) ", diffFrame, false],
  ] as const) {
    if (stopped) break;
    results.push(await bench(label, makeFrame, sync));
  }
} finally {
  restore();
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
}

console.log(`terminal bench — ${cols}x${rows} cells, ${seconds}s per mode\n`);
for (const { label, fps, mbps } of results)
  console.log(
    `${label} ${fps.toFixed(0).padStart(6)} fps   ${mbps.toFixed(1).padStart(7)} MB/s`
  );
console.log(
  isTTY
    ? "\nfps = frames the terminal accepted per second (pty backpressure respected)."
    : "\nfps = frames generated per second; no terminal writes were measured."
);
