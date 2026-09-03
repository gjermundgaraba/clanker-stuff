// Ghostty mainline visual-fidelity test card.
// Exercises the built-in sprite insetting changed by d0e72a3ab and leaves
// default-background areas for GTK 4.23.3 native blur from 74b426458.
// Run: node scripts/ghostty-mainline-fidelity-demo.ts

import assert from "node:assert/strict";

const CSI = "\x1b[";
const COLORS = [
  [255, 92, 122],
  [255, 183, 77],
  [88, 214, 141],
  [83, 179, 255],
  [180, 125, 255],
] as const;

const rgb = ([red, green, blue]: readonly number[], background = false) =>
  `${CSI}${background ? 48 : 38};2;${red};${green};${blue}m`;
const widthOf = (text: string) =>
  [...text.replaceAll(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")].length;
const row = (text: string, width: number) => {
  const visible = widthOf(text);
  if (visible > width) {
    return [...text.replaceAll(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")]
      .slice(0, width)
      .join("");
  }
  return text + " ".repeat(width - visible);
};

const render = (width: number, height: number, time: number) => {
  const lines = [
    `${CSI}1mGHOSTTY MAINLINE · VISUAL FIDELITY${CSI}0m`,
    "",
    "Built-in Powerline curves · clean, perpendicular endpoints",
  ];

  for (let index = 0; index < 5; index++) {
    const color = COLORS[(index + Math.floor(time * 2)) % COLORS.length]!;
    const offset = Math.floor((Math.sin(time * 2 + index) + 1) * 5);
    lines.push(
      `  ${" ".repeat(offset)}${rgb(color, true)}  MAINLINE  ${rgb(color)}${CSI}49m      ${CSI}0m`
    );
  }

  lines.push(
    "",
    "Sprite geometry · no hooks or light leaks",
    `  ┌────────┬────────┐   ╭────────╮   ${rgb(COLORS[3]!)}  ${CSI}0m`,
    "  │ ┏━━━━┓ │ ╔════╗ │   │ ╱╲╱╲╱╲ │",
    "  ├─┫    ┣─┼─╫    ╟─┤   ╰────────╯",
    "  └─┻━━━━┻─┴─╚════╝─┘",
    "",
    "Native blur field · keep these cells on the default background",
    "  GTK 4.23.3+: background-opacity = 0.72 · background-blur = 20"
  );

  const fieldRows = Math.max(1, height - lines.length - 1);
  for (let y = 0; y < fieldRows; y++) {
    let field = "  ";
    for (let x = 0; x < Math.max(1, width - 4); x++) {
      const wave = Math.sin(x * 0.23 + y * 0.61 - time * 2.2);
      field +=
        wave > 0.91
          ? `${rgb(COLORS[(x + y) % COLORS.length]!)}·${CSI}39m`
          : " ";
    }
    lines.push(field);
  }
  lines.push("  q quit");

  return lines
    .slice(0, height)
    .map((line) => row(line, width))
    .join("\n");
};

const check = () => {
  const first = render(72, 24, 0);
  const second = render(72, 24, 1);
  assert.notEqual(first, second);
  assert.match(first, /.*/);
  assert.match(first, /background-blur = 20/);
  assert.equal(first.split("\n").length, 24);
  assert.ok(first.split("\n").every((line) => widthOf(line) === 72));
  assert.ok(
    render(12, 8, 0)
      .split("\n")
      .every((line) => widthOf(line) === 12)
  );
  console.log("Ghostty mainline fidelity demo self-check passed.");
};

if (process.argv.includes("--check")) {
  check();
} else if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.log("Run this demo interactively in a mainline Ghostty build.");
} else {
  const input = process.stdin;
  const output = process.stdout;
  const started = performance.now();
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    input.setRawMode(false);
    input.pause();
    output.write(`${CSI}?2026l${CSI}0m${CSI}?25h${CSI}?1049l`);
  };
  const draw = () => {
    const width = Math.max(1, output.columns ?? 80);
    const height = Math.max(1, output.rows ?? 24);
    const time = (performance.now() - started) / 1000;
    output.write(
      `${CSI}?2026h${CSI}H${render(width, height, time)}${CSI}?2026l`
    );
  };

  input.setRawMode(true);
  input.resume();
  input.on("data", (chunk: Buffer) => {
    if (chunk.includes(3) || chunk.toString().toLowerCase().includes("q"))
      stop();
  });
  output.write(`${CSI}?1049h${CSI}?25l${CSI}2J`);
  const timer = setInterval(draw, 50);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  draw();
}
