// Plays Thinking Orb animations in the terminal by flipping PUA codepoints
// in place. Requires ThinkingOrbs.ttf to be available to the terminal
// (installed in ~/Library/Fonts; most terminals find it via system font
// fallback since nothing else covers U+F0000+).
//
// Usage: node scripts/orb-font/play.ts [state]   (default: cycle all states)

import { readFileSync } from "node:fs";

type Meta = { fps: number; states: Record<string, { base: number; count: number }> };
const meta: Meta = JSON.parse(
  readFileSync(new URL("./orbs-meta.json", import.meta.url), "utf8")
);

const arg = process.argv[2];
const states = arg ? [arg] : Object.keys(meta.states);
for (const s of states) {
  if (!meta.states[s]) {
    console.error(`unknown state "${s}" — one of: ${Object.keys(meta.states).join(", ")}`);
    process.exit(1);
  }
}

const out = process.stdout;
out.write("\x1b[?25l");
const restore = () => {
  out.write("\x1b[?25h\n");
  process.exit(0);
};
process.on("SIGINT", restore);
process.on("SIGTERM", restore);

let stateIndex = 0;
let frame = 0;
let loops = 0;
const LOOPS_PER_STATE = 2;

setInterval(() => {
  const name = states[stateIndex];
  const { base, count } = meta.states[name];
  const ch = String.fromCodePoint(base + frame);
  out.write(`\r\x1b[2K ${ch}  ${name}…`);
  frame++;
  if (frame >= count) {
    frame = 0;
    loops++;
    if (loops >= LOOPS_PER_STATE && states.length > 1) {
      loops = 0;
      stateIndex = (stateIndex + 1) % states.length;
    }
  }
}, 1000 / meta.fps);
