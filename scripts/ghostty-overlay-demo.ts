// Kitty graphics ABOVE-text overlay for Ghostty: an RGBA dim plate with an
// aurora is placed at z=1 so it composites over ordinary terminal text.
// The transcript is frozen; the overlay is what animates. Contrast with
// scripts/ghostty-background-demo.ts, which uses z=-1 (under the text).
//
// Run in Ghostty: node scripts/ghostty-overlay-demo.ts [--seconds 10]

import assert from "node:assert/strict";

const WIDTH = 480;
const HEIGHT = 280;
const FPS = 15;
const ESC = "\x1b";

const chunked = (payload: string, controls: string) => {
  const chunks: string[] = [];
  for (let offset = 0; offset < payload.length; offset += 4096) {
    const isFirst = offset === 0;
    const isLast = offset + 4096 >= payload.length;
    const control = isFirst
      ? `${controls},m=${isLast ? 0 : 1}`
      : `m=${isLast ? 0 : 1}`;
    chunks.push(
      `${ESC}_G${control};${payload.slice(offset, offset + 4096)}${ESC}\\`
    );
  }
  return chunks.join("");
};

const renderOverlay = (time: number) => {
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const nx = x / WIDTH;
      const ny = y / HEIGHT;
      const band =
        Math.sin(nx * 6 + time * 0.9 + Math.sin(ny * 4 + time * 0.6) * 1.4) *
        Math.exp(-((ny - 0.35 - 0.1 * Math.sin(nx * 3 + time * 0.5)) ** 2) * 9);
      const glow = Math.max(0, band);
      const offset = (y * WIDTH + x) * 4;
      pixels[offset] = Math.round(8 + 40 * glow);
      pixels[offset + 1] = Math.round(10 + 150 * glow);
      pixels[offset + 2] = Math.round(24 + 90 * glow + 25 * (1 - ny));
      // Veil ~43% opaque so transcript stays readable; aurora denser.
      pixels[offset + 3] = Math.round(110 + 70 * glow);
    }
  }
  return pixels.toString("base64");
};

if (process.argv.includes("--check")) {
  const framed = chunked("x".repeat(5000), "a=t,f=32,s=1,v=1,i=1,q=2");
  assert.equal(framed.match(/\x1b_G/gu)?.length, 2);
  assert.match(framed, /q=2,m=1;/u);
  assert.match(framed, /\x1b_Gm=0;/u);
  assert.equal(
    Buffer.from(renderOverlay(0), "base64").length,
    WIDTH * HEIGHT * 4
  );
  console.log("Ghostty overlay self-check passed.");
  process.exit(0);
}

const out = process.stdout;
if (!out.isTTY) {
  console.log("Run in Ghostty (or kitty) interactively.");
  process.exit(0);
}

const secondsArg = process.argv.indexOf("--seconds");
const seconds =
  secondsArg >= 0 ? Number(process.argv[secondsArg + 1]) || 10 : 10;
const rows = Math.max(1, (out.rows ?? 24) - 2);
const cols = Math.max(1, out.columns ?? 80);

out.write(`${ESC}[?25l${ESC}[2J${ESC}[H`);

const textLines = [
  "z=1 overlay probe: this text is the TEXT LAYER.",
  "A semi-transparent RGBA plate (f=32) is compositing ABOVE it.",
  "If Ghostty blends correctly, you can still read these lines",
  "through a dim aurora. ctrl+c stops and deletes the image.",
  "",
  "  gjermund/nice-animations",
  "  2eb3291  fix(ask-question): handle optional notes explicitly",
  "",
  "$ git status -sb",
  "## gjermund/nice-animations",
  "?? scripts/ghostty-overlay-demo.ts",
  "",
  "waiting for idle…",
];
for (const [index, line] of textLines.entries()) {
  if (index >= rows) break;
  out.write(`${ESC}[${index + 1};3H${line}`);
}

let frame = 0;
let previousId = 0;
const started = performance.now();
const cleanup = () => {
  clearInterval(timer);
  out.write(`${ESC}_Ga=d,d=A,q=2${ESC}\\`);
  out.write(`${ESC}[${rows + 1};1H${ESC}[?25h\n`);
  process.exit(0);
};
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

const timer = setInterval(() => {
  if ((performance.now() - started) / 1000 >= seconds) {
    cleanup();
    return;
  }
  frame += 1;
  const id = (frame % 2) + 50;
  out.write(`${ESC}[1;1H`);
  out.write(
    chunked(
      renderOverlay(frame / FPS),
      `a=T,f=32,s=${WIDTH},v=${HEIGHT},i=${id},z=1,c=${cols},r=${rows},q=2,C=1`
    )
  );
  if (previousId && previousId !== id)
    out.write(`${ESC}_Ga=d,d=I,i=${previousId},q=2${ESC}\\`);
  previousId = id;
}, 1000 / FPS);
