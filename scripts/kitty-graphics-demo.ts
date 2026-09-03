// Kitty graphics protocol animation demo, targeting Ghostty on this machine.
//
// Ghostty implements the stills half of the protocol (a=T transmit+display),
// not the animation actions (a=f frame transmission, a=a playback control), so
// the default mode is client-driven: render RGB frames on the CPU, transmit
// each as a fresh image at a saved cursor position, then delete the previous
// one. Run with --native to emit the protocol-native a=f/a=a form instead —
// that path needs real kitty and is included as a protocol reference.
//
// The --placements mode uploads one transparent sprite, then moves two
// placements of it above and below text without retransmitting pixels.
//
// Run: node scripts/kitty-graphics-demo.ts [--placements|--native|--native-compose] [--seconds 10]

import assert from "node:assert/strict";

const WIDTH = 240;
const HEIGHT = 136;
const ROWS = 16;
const FPS = 20;
const ESC = "\x1b";
const hashForSprite = (value: number) => {
  const result = Math.sin(value * 12.9898) * 43_758.5453;
  return result - Math.floor(result);
};

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

const placement = (
  imageId: number,
  row: number,
  column: number,
  placementId: number,
  zIndex: number,
  columns: number,
  rows: number
) =>
  `${ESC}[${row};${column}H${ESC}_Ga=p,i=${imageId},p=${placementId},c=${columns},r=${rows},C=1,z=${zIndex},q=2${ESC}\\`;

const nativeComposition = (
  imageId: number,
  sourceFrame: number,
  destinationFrame: number,
  x: number,
  y: number,
  width: number,
  height: number
) =>
  `${ESC}_Ga=c,i=${imageId},r=${sourceFrame},c=${destinationFrame},x=${x},y=${y},X=0,Y=0,w=${width},h=${height},C=1,q=2${ESC}\\`;

const renderFrame = (time: number) => {
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const nx = x / WIDTH - 0.5;
      const ny = y / HEIGHT - 0.5;
      const swirl =
        Math.sin(nx * 9 + time * 2.1) +
        Math.sin(ny * 11 - time * 1.7) +
        Math.sin((nx + ny) * 13 + time * 2.9) +
        Math.sin(Math.hypot(nx, ny) * 22 - time * 4);
      const offset = (y * WIDTH + x) * 3;
      pixels[offset] = Math.round(128 + 127 * Math.sin(swirl * 1.1));
      pixels[offset + 1] = Math.round(128 + 127 * Math.sin(swirl * 1.1 + 2.1));
      pixels[offset + 2] = Math.round(128 + 127 * Math.sin(swirl * 1.1 + 4.2));
    }
  }
  return pixels.toString("base64");
};

const renderSprite = (size = 96) => {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x / (size - 1)) * 2 - 1;
      const ny = (y / (size - 1)) * 2 - 1;
      const distance = Math.hypot(nx, ny);
      const alpha = Math.max(0, Math.min(1, (1 - distance) * 5));
      const offset = (y * size + x) * 4;
      pixels[offset] = Math.round(100 + 155 * (1 - distance));
      pixels[offset + 1] = Math.round(120 + 120 * (1 + nx) * 0.5);
      pixels[offset + 2] = 255;
      pixels[offset + 3] = Math.round(alpha * 220);
    }
  }
  return pixels;
};

const out = process.stdout;
const secondsArg = process.argv.indexOf("--seconds");
const seconds =
  secondsArg >= 0 ? Number(process.argv[secondsArg + 1]) || 10 : 10;

if (process.argv.includes("--check")) {
  const sprite = renderSprite(32);
  assert.equal(sprite.length, 32 * 32 * 4);
  assert.ok(sprite[(16 * 32 + 16) * 4 + 3]! > sprite[3]!);
  assert.match(
    chunked(sprite.toString("base64"), "a=t,f=32,s=32,v=32,i=91,q=2"),
    /^\x1b_Ga=t,f=32/
  );
  assert.match(placement(91, 2, 3, 7, -1, 14, 7), /a=p,i=91,p=7.*z=-1/);
  assert.match(
    nativeComposition(1, 2, 9, 4, 8, 23, 27),
    /a=c,i=1,r=2,c=9.*C=1/
  );
  console.log("Kitty graphics self-check passed: RGBA upload and chunking OK.");
  process.exit(0);
}

if (!out.isTTY) {
  console.log("Run in an interactive terminal (Ghostty or kitty).");
  process.exit(0);
}

if (process.argv.includes("--placements")) {
  const imageId = 91;
  const spriteSize = 96;
  const spriteColumns = 14;
  const spriteRows = 7;
  const sprite = renderSprite(spriteSize).toString("base64");
  const backdrop = Array.from(
    { length: Math.max(1, (out.rows ?? 24) - 1) },
    (_, row) => {
      if (row === Math.floor((out.rows ?? 24) / 2))
        return `${ESC}[38;2;235;240;255m${" ".repeat(Math.max(0, Math.floor(((out.columns ?? 80) - 28) / 2)))}UPLOAD ONCE · MOVE PLACEMENTS${ESC}[0m`;
      return Array.from({ length: out.columns ?? 80 }, (_, column) =>
        hashForSprite(row * 997 + column) > 0.965 ? "·" : " "
      ).join("");
    }
  ).join("\n");
  const started = performance.now();
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    out.write(
      `${ESC}_Ga=d,d=I,i=${imageId},q=2${ESC}\\${ESC}[?2026l${ESC}[?25h${ESC}[?1049l`
    );
    process.exit(0);
  };
  const draw = () => {
    const elapsed = (performance.now() - started) / 1000;
    if (elapsed >= seconds) return cleanup();
    const columns = out.columns ?? 80;
    const rows = out.rows ?? 24;
    const maxColumn = Math.max(1, columns - spriteColumns);
    const maxRow = Math.max(2, rows - spriteRows);
    const frontColumn =
      1 + Math.round(((Math.sin(elapsed * 1.4) + 1) / 2) * (maxColumn - 1));
    const frontRow =
      2 + Math.round(((Math.cos(elapsed * 1.1) + 1) / 2) * (maxRow - 2));
    const backColumn =
      1 + Math.round(((Math.sin(elapsed * 0.9 + 2) + 1) / 2) * (maxColumn - 1));
    const backRow =
      2 + Math.round(((Math.cos(elapsed * 1.3 + 1) + 1) / 2) * (maxRow - 2));
    out.write(
      `${ESC}[?2026h${placement(imageId, backRow, backColumn, 1, -1, spriteColumns, spriteRows)}${placement(imageId, frontRow, frontColumn, 2, 1, spriteColumns, spriteRows)}${ESC}[?2026l`
    );
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  out.write(`${ESC}[?1049h${ESC}[?25l${ESC}[H${backdrop}`);
  out.write(
    chunked(sprite, `a=t,f=32,s=${spriteSize},v=${spriteSize},i=${imageId},q=2`)
  );
  timer = setInterval(draw, 1000 / FPS);
  draw();
  await new Promise(() => {});
}

if (
  process.argv.includes("--native") ||
  process.argv.includes("--native-compose")
) {
  // Protocol-native: transmit root image, append frames with a=f (z = gap in
  // ms), then hand playback to the terminal with a=a. Kitty-only today:
  // Ghostty accepts the root image but ignores the animation actions, so here
  // this shows frame 1 standing still. Kept as the reference for what
  // terminal-driven playback looks like on the wire.
  const frameCount = 24;
  out.write(`kitty protocol-native animation (a=f/a=a) — needs real kitty:\n`);
  out.write(
    chunked(
      renderFrame(0),
      `a=T,f=24,s=${WIDTH},v=${HEIGHT},i=1,r=${ROWS},q=2,C=1`
    )
  );
  for (let index = 1; index < frameCount; index++) {
    const gap = Math.round(1000 / FPS);
    out.write(
      chunked(
        renderFrame(index / FPS),
        `a=f,f=24,s=${WIDTH},v=${HEIGHT},i=1,z=${gap},q=2`
      )
    );
  }
  if (process.argv.includes("--native-compose")) {
    for (let frame = 8; frame <= 20; frame += 4)
      out.write(
        nativeComposition(
          1,
          2,
          frame,
          Math.round((frame / 24) * (WIDTH - 60)),
          Math.round(((24 - frame) / 24) * (HEIGHT - 34)),
          60,
          34
        )
      );
  }
  out.write(
    `${ESC}_Ga=a,i=1,s=1,q=2${ESC}\\${ESC}_Ga=a,i=1,r=1,z=${Math.round(1000 / FPS)},q=2${ESC}\\${ESC}_Ga=a,i=1,s=3,v=${process.argv.includes("--native-compose") ? 4 : 1},q=2${ESC}\\`
  );
  out.write(
    `\n${"\n".repeat(ROWS)}done — if the image is frozen, the terminal ignored a=a.\n`
  );
  process.exit(0);
}

out.write(
  `client-driven kitty graphics animation, ${seconds}s (ctrl+c to stop)\n`
);
out.write(`${ESC}[?25l${"\n".repeat(ROWS)}${ESC}[${ROWS}A${ESC}7`);

let frame = 0;
let previousId = 0;
const started = performance.now();
const cleanup = () => {
  clearInterval(timer);
  if (previousId) out.write(`${ESC}_Ga=d,d=I,i=${previousId},q=2${ESC}\\`);
  out.write(`${ESC}8${ESC}[${ROWS}B\n${ESC}[?25h`);
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
  const id = (frame % 2) + 1;
  out.write(`${ESC}8`);
  out.write(
    chunked(
      renderFrame(frame / FPS),
      `a=T,f=24,s=${WIDTH},v=${HEIGHT},i=${id},r=${ROWS},q=2,C=1`
    )
  );
  if (previousId && previousId !== id)
    out.write(`${ESC}_Ga=d,d=I,i=${previousId},q=2${ESC}\\`);
  previousId = id;
}, 1000 / FPS);
