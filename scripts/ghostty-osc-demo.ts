// OSC-driven animation for Ghostty: the terminal itself animates — no cell
// output at all. Cycles the window background color (OSC 11) through a slow
// hue orbit and pulses the cursor color (OSC 12), then restores both with the
// standard reset sequences (OSC 111 / OSC 112).
//
// Run: node scripts/ghostty-osc-demo.ts [--seconds 8]

import assert from "node:assert/strict";

const ESC = "\x1b";
const out = process.stdout;

const hex = (value: number) =>
  Math.round(Math.max(0, Math.min(255, value)))
    .toString(16)
    .padStart(2, "0");

const colorSequence = (code: 11 | 12, r: number, g: number, b: number) =>
  `${ESC}]${code};#${hex(r)}${hex(g)}${hex(b)}${ESC}\\`;
const setBackground = (r: number, g: number, b: number) =>
  out.write(colorSequence(11, r, g, b));
const setCursor = (r: number, g: number, b: number) =>
  out.write(colorSequence(12, r, g, b));

if (process.argv.includes("--check")) {
  assert.equal(colorSequence(11, -1, 127.6, 999), `${ESC}]11;#0080ff${ESC}\\`);
  assert.equal(colorSequence(12, 1, 2, 3), `${ESC}]12;#010203${ESC}\\`);
  console.log("Ghostty OSC self-check passed.");
  process.exit(0);
}
if (!out.isTTY) {
  console.log("Run in Ghostty interactively.");
  process.exit(0);
}

const secondsArg = process.argv.indexOf("--seconds");
const seconds = secondsArg >= 0 ? Number(process.argv[secondsArg + 1]) || 8 : 8;
const started = performance.now();
const cleanup = () => {
  clearInterval(timer);
  out.write(`${ESC}]111${ESC}\\${ESC}]112${ESC}\\`);
  out.write("\nrestored (OSC 111/112).\n");
  process.exit(0);
};
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

out.write(
  `OSC demo: the background and cursor color are animating for ${seconds}s — no cells are being drawn. ctrl+c to stop early.\n`
);

const timer = setInterval(() => {
  const elapsed = (performance.now() - started) / 1000;
  if (elapsed >= seconds) {
    cleanup();
    return;
  }
  const hue = elapsed * 0.9;
  setBackground(
    18 + 14 * Math.sin(hue),
    12 + 10 * Math.sin(hue + 2.1),
    28 + 16 * Math.sin(hue + 4.2)
  );
  setCursor(
    128 + 127 * Math.sin(hue * 3),
    128 + 127 * Math.sin(hue * 3 + 2.1),
    128 + 127 * Math.sin(hue * 3 + 4.2)
  );
}, 1000 / 30);
