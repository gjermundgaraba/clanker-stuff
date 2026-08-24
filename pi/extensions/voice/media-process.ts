import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import type { VoiceTrace } from "./trace.js";

const MediaRequestSchema = Type.Union([
  Type.Object({
    id: Type.Number(),
    method: Type.Union([Type.Literal("offer"), Type.Literal("renew_offer")]),
    offer: Type.String({ minLength: 1, maxLength: 1_000_000 }),
    type: Type.Literal("request"),
  }),
  Type.Object({
    id: Type.Number(),
    method: Type.Literal("renew_commit"),
    type: Type.Literal("request"),
  }),
]);

type MediaRequest = Static<typeof MediaRequestSchema>;

const MediaEventSchema = Type.Object({
  event: Type.String(),
  message: Type.Optional(Type.String()),
  muted: Type.Optional(Type.Boolean()),
  type: Type.Literal("event"),
});

type MediaEvent = Static<typeof MediaEventSchema>;

const ReadyEventSchema = Type.Object({
  event: Type.Literal("ready"),
  type: Type.Literal("event"),
});

const ElectronPathSchema = Type.String({ minLength: 1 });

type MediaCommand =
  | { command: "shutdown"; type: "command" }
  | { event: "renew_due"; type: "event" }
  | { event: "error"; message: string; type: "event" }
  | { event: "state"; state: string; type: "event" }
  | { error?: string; id: number; ok: boolean; type: "response"; value?: string };

interface MediaProcessOptions {
  onClosed: () => void;
  onEndCall: () => void;
  onError: (message: string) => void;
  onMediaReady: () => void;
  onMuted: (muted: boolean) => void;
  onOffer: (offer: string) => Promise<string>;
  onRenewAbort: () => void;
  onRenewCommit: () => Promise<void>;
  onRenewOffer: (offer: string) => Promise<string>;
  trace?: VoiceTrace;
}

export class MediaProcess {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly options: MediaProcessOptions;
  private startup:
    | {
        reject: (error: Error) => void;
        resolve: () => void;
        timeout: ReturnType<typeof setTimeout>;
      }
    | undefined;
  private stopping = false;

  constructor(options: MediaProcessOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.child) {
      return;
    }

    const require = createRequire(import.meta.url);
    const electronModule: unknown = require("electron");
    if (!Value.Check(ElectronPathSchema, electronModule)) {
      throw new Error("Electron is not installed.");
    }
    const electronPath = Value.Parse(ElectronPathSchema, electronModule);

    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = spawn(electronPath, [fileURLToPath(new URL("media", import.meta.url))], {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.stopping = false;
    this.options.trace?.("media.spawn", {
      executable: electronPath,
      pid: child.pid,
    });

    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (data: string) => {
      const message = data.trim();
      this.options.trace?.("media.stderr", { message });
      if (message && !message.includes("DevTools listening")) {
        // Electron and Chromium diagnostics belong in pi's debug log.
        console.error(`[voice media] ${message}`);
      }
    });

    createInterface({ input: child.stdout }).on("line", (line) => {
      this.handleLine(line);
    });
    child.on("error", (error) => {
      this.rejectStartup(error);
      this.options.onError(error.message);
    });
    child.on("close", (code) => {
      this.options.trace?.("media.close", { code, stopping: this.stopping });
      if (this.child === child) {
        this.child = undefined;
      }
      this.rejectStartup(
        new Error(`Voice media window exited during startup (${code ?? "unknown"}).`),
      );
      if (!this.stopping) {
        this.options.onClosed();
      }
    });

    const { promise, reject, resolve } = Promise.withResolvers<boolean>();
    this.startup = {
      reject,
      resolve: () => {
        resolve(true);
      },
      timeout: setTimeout(() => {
        this.rejectStartup(new Error("Voice media window did not start in time."));
      }, 10_000),
    };
    await promise;
  }

  sendState(state: string): void {
    this.send({ event: "state", state, type: "event" });
  }

  sendError(message: string): void {
    this.send({ event: "error", message, type: "event" });
  }

  requestRenewal(): void {
    this.send({ event: "renew_due", type: "event" });
  }

  stop(): void {
    const { child } = this;
    if (!child) {
      return;
    }
    this.stopping = true;
    this.send({ command: "shutdown", type: "command" });
    const timeout = setTimeout(() => {
      child.kill();
    }, 1000);
    timeout.unref?.();
    child.once("close", () => {
      clearTimeout(timeout);
    });
    this.child = undefined;
  }

  private handleLine(line: string): void {
    this.options.trace?.("media.received", { line });
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (Value.Check(ReadyEventSchema, message)) {
      this.resolveStartup();
      return;
    }

    if (Value.Check(MediaRequestSchema, message)) {
      void this.handleRequest(Value.Parse(MediaRequestSchema, message));
      return;
    }
    if (Value.Check(MediaEventSchema, message)) {
      this.handleEvent(Value.Parse(MediaEventSchema, message));
    }
  }

  private async handleRequest(request: MediaRequest): Promise<void> {
    try {
      let answer: string | undefined;
      if (request.method === "offer") {
        answer = await this.options.onOffer(request.offer);
      } else if (request.method === "renew_offer") {
        answer = await this.options.onRenewOffer(request.offer);
      } else {
        await this.options.onRenewCommit();
        answer = undefined;
      }
      this.send({
        id: request.id,
        ok: true,
        type: "response",
        value: answer,
      });
    } catch (error) {
      this.send({
        error: error instanceof Error ? error.message : String(error),
        id: request.id,
        ok: false,
        type: "response",
      });
    }
  }

  private handleEvent(event: MediaEvent): void {
    switch (event.event) {
      case "end": {
        this.options.onEndCall();
        break;
      }
      case "error": {
        if (event.message !== undefined && event.message.length > 0) {
          this.options.onError(event.message);
        }
        break;
      }
      case "media_ready": {
        this.options.onMediaReady();
        break;
      }
      case "muted": {
        this.options.onMuted(event.muted === true);
        break;
      }
      case "renew_abort": {
        this.options.onRenewAbort();
        break;
      }
      case "usage_warning": {
        this.options.onError("OpenAI reports that voice usage is approaching its limit.");
        break;
      }
      default: {
        break;
      }
    }
  }

  private send(message: MediaCommand): void {
    const input = this.child?.stdin;
    if (input?.writable !== true) {
      return;
    }
    const line = JSON.stringify(message);
    this.options.trace?.("media.sent", { line });
    input.write(`${line}\n`);
  }

  private resolveStartup(): void {
    if (!this.startup) {
      return;
    }
    clearTimeout(this.startup.timeout);
    this.startup.resolve();
    this.startup = undefined;
  }

  private rejectStartup(error: Error): void {
    if (!this.startup) {
      return;
    }
    clearTimeout(this.startup.timeout);
    this.startup.reject(error);
    this.startup = undefined;
  }
}
