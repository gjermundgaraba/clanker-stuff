import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// Build-time only. No npm/browser dependency is needed to load the extension.
import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

import { frame, FPS, INKS, paint, SEED, STRIKES, VIEWBOX } from "./frames.ts";
import { SHAPES } from "./geometry.ts";

const destination = process.argv.at(2);

if (destination === undefined || destination === "") {
  throw new Error("Usage: node scripts/render.ts output.json");
}

const profile = await mkdtemp(path.join(os.tmpdir(), "shape-spinner-chrome-"));

const chromeOverride = process.env["CHROME"];

const chrome = spawn(
  chromeOverride === undefined || chromeOverride === ""
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : chromeOverride,
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
  { stdio: "ignore" }
);

let launchError: Error | undefined;

chrome.on("error", (error) => {
  launchError = error;
});

const exited = Promise.withResolvers();

chrome.once("close", exited.resolve);

const pending = new Map<
  number,
  ReturnType<typeof Promise.withResolvers<unknown>>
>();

let socket: WebSocket | undefined;

const timeout = setTimeout(() => {
  for (const request of pending.values()) {
    request.reject(new Error("Chrome render timed out"));
  }

  socket?.close();
  chrome.kill();
}, 300_000);

try {
  let port;

  for (let i = 0; i < 100; i += 1) {
    if (launchError) {
      throw launchError;
    }

    try {
      const portFile = await readFile(
        path.join(profile, "DevToolsActivePort"),
        "utf-8"
      );

      [port] = portFile.split("\n");
      break;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }

      await sleep(100);
    }
  }

  if (port === undefined || port === "") {
    throw new Error(
      "Chrome did not expose its debugging port; set CHROME to the executable"
    );
  }

  const response = await fetch(
    `http://127.0.0.1:${port}/json/new?about:blank`,
    {
      method: "PUT",
      signal: AbortSignal.timeout(10_000),
    }
  );

  const target = Value.Parse(
    Type.Object({ webSocketDebuggerUrl: Type.String() }),
    await response.json()
  );

  const connection = new WebSocket(target.webSocketDebuggerUrl);
  socket = connection;
  const opened = Promise.withResolvers();
  connection.addEventListener("open", opened.resolve, { once: true });
  connection.addEventListener("error", opened.reject, { once: true });
  await opened.promise;
  let serial = 0;
  connection.addEventListener("message", ({ data }) => {
    const text: unknown = data;

    if (typeof text !== "string") {
      throw new TypeError("Chrome sent a non-text response");
    }

    const message = Value.Parse(
      Type.Object({
        id: Type.Optional(Type.Integer()),
        error: Type.Optional(Type.Unknown()),
        result: Type.Optional(Type.Unknown()),
      }),
      JSON.parse(text)
    );

    if (message.id === undefined) {
      // Unsolicited CDP event, not a reply.
      return;
    }

    const request = pending.get(message.id);

    if (!request) {
      return;
    }

    pending.delete(message.id);

    if (message.error === undefined) {
      request.resolve(message.result);
    } else {
      request.reject(new Error(JSON.stringify(message.error)));
    }
  });
  connection.addEventListener("close", () => {
    for (const request of pending.values()) {
      request.reject(new Error("Chrome connection closed"));
    }

    pending.clear();
  });

  /** Sends one CDP command and decodes its result with the schema the caller expects. */
  const call = async <T extends TSchema>(
    resultSchema: T,
    method: "Runtime.evaluate" | "Browser.getVersion",
    params?: { expression: string; returnByValue: true }
  ): Promise<Static<T>> => {
    const request = Promise.withResolvers<unknown>();
    serial += 1;
    const id = serial;
    pending.set(id, request);
    connection.send(
      JSON.stringify({ id, method, ...(params ? { params } : {}) })
    );

    return Value.Parse(resultSchema, await request.promise);
  };

  /** Evaluates remote JavaScript and decodes the value it returns with the given schema. */
  const evaluate = async <T extends TSchema>(
    valueSchema: T,
    expression: string
  ): Promise<Static<T>> => {
    const result = await call(
      Type.Object({
        result: Type.Object({ value: Type.Optional(Type.Unknown()) }),
        exceptionDetails: Type.Optional(Type.Unknown()),
      }),
      "Runtime.evaluate",
      { expression, returnByValue: true }
    );

    if (result.exceptionDetails !== undefined) {
      throw new Error(JSON.stringify(result.exceptionDetails));
    }

    return Value.Parse(valueSchema, result.result.value);
  };

  const { product: browser } = await call(
    Type.Object({ product: Type.String() }),
    "Browser.getVersion"
  );

  // The assignment's value is the installed function, which the render ignores.
  await evaluate(Type.Unknown(), `globalThis.paint = ${paint.toString()}`);

  const animations: Record<
    string,
    Record<string, Record<string, string[][]>>
  > = {};

  for (const shape of SHAPES) {
    const colors: Record<string, Record<string, string[][]>> = {};
    animations[shape] = colors;

    const scenes = Array.from({ length: FPS * 8 }, (_, i) =>
      frame(shape, i / FPS)
    );

    scenes.push(frame(shape, 0, true));

    for (const [name, inks] of Object.entries(INKS)) {
      const backgrounds: Record<string, string[][]> = {};
      colors[name] = backgrounds;

      for (const [background, color] of Object.entries(inks)) {
        const sprites: string[][] = [];

        for (let start = 0; start < scenes.length; start += 24) {
          const batch = scenes.slice(start, start + 24);
          sprites.push(
            ...(await evaluate(
              Type.Array(Type.Array(Type.String())),
              `(${JSON.stringify(batch)}).map(scene => {
          const canvas = document.createElement('canvas');
          return ${JSON.stringify(STRIKES)}.map(pixels => {
            paint(canvas, scene, pixels, ${JSON.stringify(color)}, ${VIEWBOX});
            return canvas.toDataURL('image/png').split(',')[1];
          });
        })`
            ))
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
    })
  );
} finally {
  clearTimeout(timeout);
  socket?.close();
  chrome.kill("SIGTERM");

  const force = setTimeout(() => {
    chrome.kill("SIGKILL");
  }, 3000);

  await exited.promise;
  clearTimeout(force);
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
