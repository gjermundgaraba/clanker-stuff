// Build-time only. No npm/browser dependency is needed to load the extension.
import { Type } from "typebox";
import { Value } from "typebox/value";

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { frame, FPS, INKS, paint, SEED, STRIKES, VIEWBOX } from "./frames.ts";
import { SHAPES } from "./geometry.ts";

const destination = process.argv[2];

if (!destination) throw new Error("Usage: node scripts/render.ts output.json");

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

let launchError: Error | undefined;

chrome.on("error", (error) => {
  launchError = error;
});

const exited = new Promise((resolve) => chrome.once("close", resolve));

const pending = new Map<number, ReturnType<typeof Promise.withResolvers<unknown>>>();

let socket: WebSocket | undefined;

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
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      await sleep(100);
    }
  }

  if (!port)
    throw new Error("Chrome did not expose its debugging port; set CHROME to the executable");

  const target = Value.Parse(
    Type.Object({ webSocketDebuggerUrl: Type.String() }),
    await (
      await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
        method: "PUT",
        signal: AbortSignal.timeout(10_000),
      })
    ).json(),
  );

  const connection = new WebSocket(target.webSocketDebuggerUrl);
  socket = connection;
  await new Promise((resolve, reject) => {
    connection.addEventListener("open", resolve, { once: true });
    connection.addEventListener("error", reject, { once: true });
  });
  let serial = 0;
  connection.addEventListener("message", ({ data }) => {
    const text: unknown = data;

    if (typeof text !== "string") throw new Error("Chrome sent a non-text response");

    const message = Value.Parse(
      Type.Object({
        id: Type.Optional(Type.Integer()),
        error: Type.Optional(Type.Unknown()),
        result: Type.Optional(Type.Unknown()),
      }),
      JSON.parse(text),
    );

    if (message.id === undefined) return; // Unsolicited CDP event, not a reply.
    const request = pending.get(message.id);

    if (!request) return;
    pending.delete(message.id);

    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  connection.addEventListener("close", () => {
    for (const request of pending.values()) request.reject(new Error("Chrome connection closed"));
    pending.clear();
  });

  const call = (
    method: "Runtime.evaluate" | "Browser.getVersion",
    params?: { expression: string; returnByValue: true },
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- CDP method results are decoded by the requesting operation, not assumed safe by the transport.
  ): Promise<unknown> => {
    const request = Promise.withResolvers<unknown>();
    const id = ++serial;
    pending.set(id, request);
    connection.send(JSON.stringify({ id, method, ...(params ? { params } : {}) }));

    return request.promise;
  };

  // oxlint-disable-next-line anti-slop/no-unknown-returns -- Remote JavaScript can return any JSON value; consumers decode the expected evaluation result.
  const evaluate = async (expression: string): Promise<unknown> => {
    const result = Value.Parse(
      Type.Object({
        result: Type.Object({ value: Type.Optional(Type.Unknown()) }),
        exceptionDetails: Type.Optional(Type.Unknown()),
      }),
      await call("Runtime.evaluate", { expression, returnByValue: true }),
    );

    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));

    return result.result.value;
  };

  const browser = Value.Parse(
    Type.Object({ product: Type.String() }),
    await call("Browser.getVersion"),
  ).product;

  await evaluate(`globalThis.paint = ${paint.toString()}`);
  const animations: Record<string, Record<string, Record<string, string[][]>>> = {};

  for (const shape of SHAPES) {
    const colors: Record<string, Record<string, string[][]>> = {};
    animations[shape] = colors;
    const scenes = Array.from({ length: FPS * 8 }, (_, i) => frame(shape, i / FPS));
    scenes.push(frame(shape, 0, true));

    for (const [name, inks] of Object.entries(INKS)) {
      const backgrounds: Record<string, string[][]> = {};
      colors[name] = backgrounds;

      for (const [background, color] of Object.entries(inks)) {
        const sprites: string[][] = [];

        for (let start = 0; start < scenes.length; start += 24) {
          const batch = scenes.slice(start, start + 24);
          sprites.push(
            ...Value.Parse(
              Type.Array(Type.Array(Type.String())),
              await evaluate(`(${JSON.stringify(batch)}).map(scene => {
          const canvas = document.createElement('canvas');
          return ${JSON.stringify(STRIKES)}.map(pixels => {
            paint(canvas, scene, pixels, ${JSON.stringify(color)}, ${VIEWBOX});
            return canvas.toDataURL('image/png').split(',')[1];
          });
        })`),
            ),
          );
        }

        backgrounds[background] = sprites;
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
