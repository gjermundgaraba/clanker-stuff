// Ghostty mainline-only visibility-aware animation.
// Requires commit 03eaa01d484b8c6a098bc94c948e474f33879677 or newer.
// Run: node scripts/ghostty-mainline-visibility-demo.ts

import assert from "node:assert/strict";

const CSI = "\x1b[";
const ENABLE_REPORTS = `${CSI}?2033h`;
const DISABLE_REPORTS = `${CSI}?2033l`;
const QUERY_VISIBILITY = `${CSI}?998n`;
const REPORT_PATTERN = /\x1b\[\?999;([12])n/g;
const REPORT_PREFIXES = [
  `${CSI}?999;1`,
  `${CSI}?999;2`,
  `${CSI}?999;`,
  `${CSI}?999`,
  `${CSI}?99`,
  `${CSI}?9`,
  `${CSI}?`,
  CSI,
  "\x1b",
] as const;
const FPS = 20;

type Visibility = "awaiting" | "potentially visible" | "not visible";

const parseReports = (input: string): Visibility[] =>
  [...input.matchAll(REPORT_PATTERN)].map((match) =>
    match[1] === "2" ? "not visible" : "potentially visible"
  );

const splitReportInput = (input: string) => {
  const carry = REPORT_PREFIXES.find((prefix) => input.endsWith(prefix)) ?? "";
  return {
    carry,
    complete: carry ? input.slice(0, -carry.length) : input,
  };
};

const renderFrame = (
  width: number,
  height: number,
  time: number,
  visibility: Visibility,
  rendered: number,
  skipped: number
) => {
  const grid = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => " ")
  );
  const put = (row: number, column: number, text: string) => {
    const line = grid[row];
    if (!line) return;
    for (const [offset, character] of [...text].entries()) {
      const x = column + offset;
      if (x >= 0 && x < width) line[x] = character;
    }
  };

  put(0, 0, "GHOSTTY MAINLINE · VISIBILITY-AWARE MOTION");
  put(2, 2, `surface: ${visibility}`);
  put(3, 2, `rendered: ${String(rendered).padStart(6)} frames`);
  put(4, 2, `skipped:  ${String(skipped).padStart(6)} hidden frames`);
  put(6, 2, "DEC mode 2033 pauses writes while hidden");
  put(7, 2, "CSI ? 998 n queries · CSI ? 999 ; Ps n reports");

  const centerX = Math.max(4, Math.floor(width * 0.72));
  const centerY = Math.max(9, Math.floor(height / 2));
  const radiusX = Math.max(3, Math.min(12, Math.floor(width / 7)));
  const radiusY = Math.max(2, Math.min(5, Math.floor(height / 4)));
  for (let index = 0; index < 12; index++) {
    const angle = time * 2 + (index / 12) * Math.PI * 2;
    put(
      centerY + Math.round(Math.sin(angle) * radiusY),
      centerX + Math.round(Math.cos(angle) * radiusX),
      index === 0 ? "●" : index < 4 ? "•" : "·"
    );
  }
  put(height - 2, 2, "Hide/show the surface, then press q to quit.");
  put(
    height - 1,
    2,
    "GTK tracks suspension; macOS may stay potentially visible."
  );

  return grid.map((line) => line.join("")).join("\n");
};

const runCheck = () => {
  assert.deepEqual(parseReports(`noise${CSI}?999;1n${CSI}?999;2n`), [
    "potentially visible",
    "not visible",
  ]);
  assert.equal(parseReports("unsupported").length, 0);
  const partial = splitReportInput(`${CSI}?999;`);
  assert.equal(partial.complete, "");
  assert.deepEqual(
    parseReports(splitReportInput(`${partial.carry}2n`).complete),
    ["not visible"]
  );
  assert.equal(ENABLE_REPORTS, "\x1b[?2033h");
  assert.equal(QUERY_VISIBILITY, "\x1b[?998n");
  const frame = renderFrame(64, 16, 1, "potentially visible", 20, 40);
  assert.equal(frame.split("\n").length, 16);
  assert.match(frame, /rendered:\s+20 frames/);
  assert.match(frame, /skipped:\s+40 hidden frames/);
  console.log("Ghostty mainline visibility demo self-check passed.");
};

if (process.argv.includes("--check")) {
  runCheck();
} else if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.log("Run this demo interactively in a mainline Ghostty build.");
} else {
  const input = process.stdin;
  const output = process.stdout;
  const started = performance.now();
  let visibility: Visibility = "awaiting";
  let rendered = 0;
  let skipped = 0;
  let stopped = false;
  let reportCarry = "";

  const restore = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    input.off("data", onInput);
    input.setRawMode(false);
    input.pause();
    output.write(
      `${DISABLE_REPORTS}${CSI}?2026l${CSI}0m${CSI}?25h${CSI}?1049l`
    );
  };
  const stop = (code = 0, error?: unknown) => {
    restore();
    if (error) console.error(error);
    process.exitCode = code;
  };
  const onInput = (chunk: Buffer) => {
    const { carry, complete } = splitReportInput(
      reportCarry + chunk.toString()
    );
    reportCarry = carry;
    for (const report of parseReports(complete)) visibility = report;
    const keys = complete.replaceAll(REPORT_PATTERN, "");
    if (chunk.includes(3) || keys.toLowerCase().includes("q")) stop();
  };
  const draw = () => {
    if (stopped) return;
    if (visibility === "not visible") {
      skipped++;
      return;
    }
    try {
      rendered++;
      const width = Math.max(1, output.columns ?? 80);
      const height = Math.max(1, output.rows ?? 24);
      const time = (performance.now() - started) / 1000;
      const frame = renderFrame(
        width,
        height,
        time,
        visibility,
        rendered,
        skipped
      );
      output.write(`${CSI}?2026h${CSI}H${frame}${CSI}?2026l`);
    } catch (error) {
      stop(1, error);
    }
  };

  input.setRawMode(true);
  input.resume();
  input.on("data", onInput);
  output.write(
    `${CSI}?1049h${CSI}?25l${CSI}2J${CSI}H${ENABLE_REPORTS}${QUERY_VISIBILITY}`
  );
  const timer = setInterval(draw, 1000 / FPS);
  process.once("SIGINT", () => stop());
  process.once("SIGTERM", () => stop());
  draw();
}
