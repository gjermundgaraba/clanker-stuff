// Zero-cell-redraw animation for Ghostty: draw indexed-color art once, then
// rotate palette entries 16–31 with OSC 4. The terminal recolors the existing
// cells; each animation tick is only one small control sequence.
//
// Run: node scripts/palette-cycle-demo.ts [--seconds 20]

import assert from "node:assert/strict";

const ESC = "\x1b";
const CSI = `${ESC}[`;
const INDICES = Array.from({ length: 16 }, (_, index) => 16 + index);
const resetPalette = `${ESC}]104;${INDICES.join(";")}${ESC}\\`;

const rgb = (phase: number) =>
  [0, 2.094, 4.188].map((offset) =>
    Math.round(127.5 + 127.5 * Math.sin(phase + offset))
  );

const palette = (time: number) => {
  const pairs = INDICES.flatMap((index, offset) => {
    const [red, green, blue] = rgb(offset * 0.34 - time * 2.2);
    return [
      index,
      `#${red!.toString(16).padStart(2, "0")}${green!.toString(16).padStart(2, "0")}${blue!.toString(16).padStart(2, "0")}`,
    ];
  });
  return `${CSI}?2026h${ESC}]4;${pairs.join(";")}${ESC}\\${CSI}?2026l`;
};

const colorAt = (x: number, y: number) => {
  const value =
    Math.sin(x * 0.19) +
    Math.cos(y * 0.33) +
    Math.sin(Math.hypot(x - 34, y * 1.7 - 18) * 0.24);
  return 16 + Math.max(0, Math.min(15, Math.floor(((value + 3) / 6) * 16)));
};

const picture = (width: number, rows: number) => {
  const lines = [
    `${CSI}38;2;220;230;255mPALETTE-ONLY PLASMA${CSI}0m  ${CSI}2mdraw once · animate with OSC 4 · ctrl+c to stop${CSI}0m`,
  ];
  for (let row = 0; row < rows; row++) {
    const parts: string[] = [];
    let previous = "";
    for (let column = 0; column < width; column++) {
      const colors = `${colorAt(column, row * 2)};48;5;${colorAt(column, row * 2 + 1)}`;
      if (colors !== previous) parts.push(`${CSI}38;5;${colors}m`);
      parts.push("▀");
      previous = colors;
    }
    lines.push(`${parts.join("")}${CSI}0m`);
  }
  return lines.join("\n");
};

if (process.argv.includes("--check")) {
  const frame = picture(40, 10);
  const usedColors = new Set(
    [...frame.matchAll(/(?:38|48);5;(\d+)/g)].map((match) => match[1])
  );
  assert.equal(frame.split("\n").length, 11);
  assert.ok(usedColors.size >= 12, "picture should use most palette entries");
  assert.match(palette(1), /\x1b\]4;16;#[0-9a-f]{6}/);
  assert.ok(palette(1).length < 400, "palette tick should stay small");
  console.log(
    "Palette demo self-check passed: 16 indexed colors, zero redraws."
  );
  process.exit(0);
}

const out = process.stdout;
if (!out.isTTY || process.env.TERM === "dumb") {
  console.log(
    "Run in an interactive terminal with OSC 4 support (Ghostty 1.2+)."
  );
  process.exit(0);
}

const secondsArg = process.argv.indexOf("--seconds");
const seconds =
  secondsArg >= 0 ? Number(process.argv[secondsArg + 1]) || 20 : 20;
const started = performance.now();
let timer: ReturnType<typeof setInterval> | undefined;
let stopped = false;
const cleanup = () => {
  if (stopped) return;
  stopped = true;
  if (timer) clearInterval(timer);
  out.write(`${resetPalette}${CSI}0m${CSI}?25h${CSI}?1049l`);
};

process.once("SIGINT", cleanup);
process.once("SIGTERM", cleanup);
out.write(
  `${CSI}?1049h${CSI}?25l${CSI}H${picture(out.columns, Math.max(1, out.rows - 2))}`
);
timer = setInterval(() => {
  const elapsed = (performance.now() - started) / 1000;
  if (elapsed >= seconds) cleanup();
  else out.write(palette(elapsed));
}, 1000 / 30);
