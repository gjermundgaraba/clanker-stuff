// Kitty graphics z-index demo for Ghostty: an animated aurora image placed
// with z=-1 renders BELOW the text layer, so ordinary terminal output scrolls
// and edits on top of a live animated background. Client-driven frames with
// double-buffered image ids, like scripts/kitty-graphics-demo.ts.
//
// Run: node scripts/ghostty-background-demo.ts [--seconds 12]

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

const renderAurora = (time: number) => {
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const nx = x / WIDTH;
      const ny = y / HEIGHT;
      const band =
        Math.sin(nx * 6 + time * 0.9 + Math.sin(ny * 4 + time * 0.6) * 1.4) *
        Math.exp(-((ny - 0.35 - 0.1 * Math.sin(nx * 3 + time * 0.5)) ** 2) * 9);
      const glow = Math.max(0, band);
      const offset = (y * WIDTH + x) * 3;
      pixels[offset] = Math.round(8 + 40 * glow);
      pixels[offset + 1] = Math.round(10 + 150 * glow);
      pixels[offset + 2] = Math.round(24 + 90 * glow + 25 * (1 - ny));
    }
  }
  return pixels.toString("base64");
};

if (process.argv.includes("--check")) {
  const framed = chunked("x".repeat(5000), "a=t,f=24,s=1,v=1,i=1,q=2");
  assert.equal(framed.match(/\x1b_G/gu)?.length, 2);
  assert.match(framed, /q=2,m=1;/u);
  assert.match(framed, /\x1b_Gm=0;/u);
  assert.equal(
    Buffer.from(renderAurora(0), "base64").length,
    WIDTH * HEIGHT * 3
  );
  console.log("Ghostty background self-check passed.");
  process.exit(0);
}

const out = process.stdout;
if (!out.isTTY) {
  console.log("Run in Ghostty (or kitty) interactively.");
  process.exit(0);
}

const secondsArg = process.argv.indexOf("--seconds");
const seconds =
  secondsArg >= 0 ? Number(process.argv[secondsArg + 1]) || 12 : 12;
const rows = Math.max(1, Math.min(out.rows ?? 30, 24) - 2);
const cols = Math.max(1, out.columns ?? 80);

out.write(`${ESC}[?25l`);
out.write(`${"\n".repeat(rows + 1)}${ESC}[${rows + 1}A${ESC}7`);

// Foreground text the background animates underneath.
const textLines = [
  "z-index demo: this text is the TEXT LAYER.",
  "The aurora underneath is a kitty-graphics placement with z=-1,",
  "re-transmitted each frame while the text just sits here.",
  "",
  "$ tail -f build.log",
  "compiling scene graph ... ok",
  "linking renderer ......... ok",
  "42 tests passed",
];
for (const [index, line] of textLines.entries()) {
  out.write(`${ESC}8${ESC}[${index + 1}B${ESC}[2C${line}`);
}

let frame = 0;
let previousId = 0;
const started = performance.now();
const cleanup = () => {
  clearInterval(timer);
  out.write(`${ESC}_Ga=d,d=A,q=2${ESC}\\`);
  out.write(`${ESC}8${ESC}[${rows + 1}B\n${ESC}[?25h`);
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
  const id = (frame % 2) + 40;
  out.write(`${ESC}8`);
  out.write(
    chunked(
      renderAurora(frame / FPS),
      `a=T,f=24,s=${WIDTH},v=${HEIGHT},i=${id},z=-1,c=${cols},r=${rows},q=2,C=1`
    )
  );
  if (previousId && previousId !== id)
    out.write(`${ESC}_Ga=d,d=I,i=${previousId},q=2${ESC}\\`);
  previousId = id;
}, 1000 / FPS);
