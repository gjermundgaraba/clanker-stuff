import assert from "node:assert/strict";

const CSI = "\x1b[";
const OSC = "\x1b]";
const ST = "\x1b\\";
const RESET = `${CSI}0m`;
const DEMO_SECONDS = 5;
const DEMOS = [
  "Styled underline comet",
  "Hardware cursor beacon",
  "Bounded log conveyor",
  "Combined long-task state",
] as const;

const at = (row: number, column: number) => `${CSI}${row};${column}H`;
const pointer = (shape: "default" | "progress" | "wait") =>
  `${OSC}22;${shape}${ST}`;
const cursorColor = (red: number, green: number, blue: number) =>
  `${OSC}12;rgb:${red.toString(16).padStart(2, "0")}/${green
    .toString(16)
    .padStart(2, "0")}/${blue.toString(16).padStart(2, "0")}${ST}`;
const progress = (state: 0 | 1 | 2 | 3 | 4, value = 0) =>
  `${OSC}9;4;${state};${value}${ST}`;
const title = (name: string) =>
  `${at(1, 1)}${CSI}2K${CSI}1;38;2;121;192;255mTERMINAL PROTOCOL MICRO LAB${RESET}` +
  `${at(2, 1)}${CSI}2K${CSI}2m${name}${RESET}`;
const restoreProtocols = () =>
  `${CSI}r${CSI}0 q${OSC}112${ST}${pointer("default")}${progress(0)}${RESET}${CSI}?25h`;

const underlineFrame = (time: number) => {
  const text = "diagnostic underline";
  const head = Math.floor(time * 9) % text.length;
  const styles = [1, 2, 3, 4, 5] as const;
  const rendered = [...text]
    .map((character, index) => {
      const distance = (head - index + text.length) % text.length;
      if (distance > 3) return `${CSI}2m${character}${RESET}`;
      const style = styles[Math.min(distance, styles.length - 1)]!;
      const red = Math.max(90, 244 - distance * 40);
      const green = Math.min(210, 106 + distance * 28);
      return `${CSI}4:${style};58:2::${red}:${green}:116m${character}${CSI}24;59m`;
    })
    .join("");
  return (
    title(DEMOS[0]) +
    `${at(6, 8)}${CSI}2K${rendered}` +
    `${at(9, 8)}${CSI}2K${CSI}2mOne changed cell can carry style, color, and direction.${RESET}`
  );
};

const cursorFrame = (time: number) => {
  const states = [
    [2, "BLOCK", [121, 192, 255]],
    [6, "BAR", [123, 211, 137]],
    [4, "UNDERLINE", [238, 190, 101]],
  ] as const;
  const [shape, label, [red, green, blue]] =
    states[Math.floor(time * 1.5) % states.length]!;
  return (
    title(DEMOS[1]) +
    `${at(6, 8)}${CSI}2Kstate: ${CSI}1m${label.padEnd(9)}${RESET}` +
    `${at(8, 8)}${CSI}2Kedit here  ` +
    `${CSI}${shape} q${cursorColor(red, green, blue)}${CSI}?25h`
  );
};

const combinedFrame = (time: number) => {
  const phase = time % DEMO_SECONDS;
  const value = Math.min(100, Math.round(phase * 24));
  const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]![
    Math.floor(time * 12) % 10
  ];
  const done = value === 100;
  const terminalState: 0 | 1 | 4 = done ? 0 : phase > 3.2 ? 4 : 1;
  const pointerShape = done ? "default" : phase > 3.2 ? "wait" : "progress";
  const marker = done
    ? `${CSI}38;2;123;211;137m✓`
    : `${CSI}38;2;121;192;255m${spinner}`;
  const width = 34;
  const filled = Math.round((value / 100) * width);
  const bar = `${CSI}38;2;123;211;137m${"━".repeat(filled)}${CSI}2m${"─".repeat(width - filled)}${RESET}`;
  const digit = String(value).padStart(3);
  const rollingDigit = `${CSI}4:3;58:2::121:192:255m${digit.at(-1)}${CSI}24;59m`;
  return (
    title(DEMOS[3]) +
    `${pointer(pointerShape)}${progress(terminalState, value)}` +
    `${at(5, 8)}${CSI}2K${marker}${RESET} Build release  ${CSI}2m${phase.toFixed(1)}s${RESET}` +
    `${at(7, 8)}${CSI}2K${bar} ${digit.slice(0, -1)}${rollingDigit}%` +
    `${at(9, 8)}${CSI}2K${CSI}2mspinner + timer + progress + pointer + cursor${RESET}` +
    `${at(5, 7)}${CSI}${done ? 2 : 6} q${cursorColor(done ? 123 : 121, done ? 211 : 192, done ? 137 : 255)}${CSI}?25h`
  );
};

const scrollSetup = () => {
  const rows = Array.from(
    { length: 6 },
    (_, index) =>
      `${at(5 + index, 8)}${CSI}2K${CSI}2mqueued event ${index + 1}${RESET}`
  ).join("");
  return (
    title(DEMOS[2]) +
    `${at(3, 1)}${CSI}2Kheader stays fixed` +
    rows +
    `${at(12, 1)}${CSI}2Kfooter stays fixed` +
    `${CSI}5;10r${CSI}?25l`
  );
};

const scrollTick = (tick: number) =>
  `${at(10, 1)}${CSI}1S${at(10, 8)}${CSI}2K${CSI}38;2;121;192;255mreceived event ${String(tick).padStart(2, "0")}${RESET}`;

const runCheck = () => {
  assert.deepEqual(new Set(DEMOS).size, DEMOS.length);
  assert.match(underlineFrame(0.5), /\x1b\[4:[1-5];58:2::/);
  assert.match(cursorFrame(0.5), /\x1b\[[246] q/);
  assert.ok(scrollSetup().includes(`${CSI}5;10r`));
  assert.ok(scrollTick(3).includes(`${CSI}1S`));
  assert.ok(combinedFrame(1).includes(`${OSC}9;4;1;`));
  assert.ok(restoreProtocols().includes(`${OSC}112${ST}`));
  console.log(`Checked ${DEMOS.length} terminal-native micro demos.`);
};

if (process.argv.includes("--check")) {
  runCheck();
} else if (
  process.argv.includes("--list") ||
  !process.stdout.isTTY ||
  !process.stdin.isTTY
) {
  console.log(DEMOS.join("\n"));
  if (!process.argv.includes("--list"))
    console.log("\nRun in Ghostty for the live protocol demo.");
} else {
  const started = performance.now();
  let stopped = false;
  let activeDemo = -1;
  let lastScrollTick = -1;
  const stdout = process.stdout;
  const stdin = process.stdin;

  const restore = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    stdin.off("data", onInput);
    stdin.setRawMode(false);
    stdin.pause();
    stdout.write(`${restoreProtocols()}${CSI}?1049l`);
  };
  const stop = () => {
    restore();
    process.exitCode = 0;
  };
  const onInput = (chunk: Buffer) => {
    if (chunk.includes(3) || chunk.toString().toLowerCase().includes("q"))
      stop();
  };
  const draw = () => {
    const elapsed = (performance.now() - started) / 1000;
    const demo = Math.floor(elapsed / DEMO_SECONDS) % DEMOS.length;
    const time = elapsed % DEMO_SECONDS;
    if (demo !== activeDemo) {
      stdout.write(`${restoreProtocols()}${CSI}2J${CSI}H`);
      activeDemo = demo;
      lastScrollTick = -1;
      if (demo === 2) stdout.write(scrollSetup());
    }
    if (demo === 2) {
      const tick = Math.floor(time * 3);
      if (tick !== lastScrollTick) {
        stdout.write(scrollTick(tick));
        lastScrollTick = tick;
      }
      return;
    }
    const frame =
      demo === 0
        ? underlineFrame(time)
        : demo === 1
          ? cursorFrame(time)
          : combinedFrame(time);
    stdout.write(`${CSI}?2026h${CSI}?25l${frame}${CSI}?2026l`);
  };

  stdin.setRawMode(true);
  stdin.resume();
  stdin.on("data", onInput);
  stdout.write(`${CSI}?1049h${CSI}2J${CSI}H`);
  const timer = setInterval(draw, 1000 / 15);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  draw();
}
