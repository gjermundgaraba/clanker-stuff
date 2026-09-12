// Build-time only. No npm/browser dependency is needed to load the extension.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { frame, FPS, INKS, paint, SEED, STRIKES, VIEWBOX } from "./frames.ts";
import { SHAPES } from "./geometry.ts";

const destination = process.argv[2];
if (!destination) throw new Error("Usage: node scripts/render.mjs output.json");
const profile = await mkdtemp(path.join(os.tmpdir(), "shape-spinner-chrome-"));
const chrome = spawn(
  process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  [
    "--headless",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);
let launchError;
chrome.on("error", (error) => {
  launchError = error;
});
const exited = new Promise((resolve) => chrome.once("close", resolve));
const pending = new Map();
let socket;
const timeout = setTimeout(() => {
  for (const request of pending.values()) request.reject(new Error("Chrome render timed out"));
  socket?.close();
  chrome.kill();
}, 300_000);
try {
  let port;
  for (let i = 0; i < 100; i++) {
    if (launchError) throw launchError;
    try {
      port = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0];
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await sleep(100);
    }
  }
  if (!port)
    throw new Error("Chrome did not expose its debugging port; set CHROME to the executable");
  const target = await (
    await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
      method: "PUT",
      signal: AbortSignal.timeout(10_000),
    })
  ).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let serial = 0;
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const request of pending.values()) request.reject(new Error("Chrome connection closed"));
    pending.clear();
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++serial;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const browser = (await call("Browser.getVersion")).product;
  await evaluate(`globalThis.paint = ${paint.toString()}`);
  const animations = {};
  for (const shape of SHAPES) {
    animations[shape] = {};
    const scenes = Array.from({ length: FPS * 8 }, (_, i) => frame(shape, i / FPS));
    scenes.push(frame(shape, 0, true));
    for (const [name, inks] of Object.entries(INKS)) {
      animations[shape][name] = {};
      for (const [background, color] of Object.entries(inks)) {
        const sprites = [];
        for (let start = 0; start < scenes.length; start += 24) {
          const batch = scenes.slice(start, start + 24);
          sprites.push(
            ...(await evaluate(`(${JSON.stringify(batch)}).map(scene => {
          const canvas = document.createElement('canvas');
          return ${JSON.stringify(STRIKES)}.map(pixels => {
            paint(canvas, scene, pixels, ${JSON.stringify(color)}, ${VIEWBOX});
            return canvas.toDataURL('image/png').split(',')[1];
          });
        })`)),
          );
        }
        animations[shape][name][background] = sprites;
      }
    }
    process.stderr.write(`Rendered ${shape}\n`);
  }
  await writeFile(
    destination,
    JSON.stringify({
      fps: FPS,
      seed: SEED,
      strikes: STRIKES,
      inks: INKS,
      viewbox: VIEWBOX,
      browser,
      animations,
    }),
  );
} finally {
  clearTimeout(timeout);
  socket?.close();
  chrome.kill("SIGTERM");
  const force = setTimeout(() => chrome.kill("SIGKILL"), 3000);
  await exited;
  clearTimeout(force);
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
