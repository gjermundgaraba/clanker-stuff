import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import type { VoiceTrace } from "./trace.js";

type MediaRequest =
  | {
      id: number;
      method: "offer" | "renew_offer";
      offer: string;
      type: "request";
    }
  | {
      id: number;
      method: "renew_commit";
      type: "request";
    };

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

interface MediaEvent {
  event: string;
  message?: string;
  muted?: boolean;
  type: "event";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isMediaRequest = (value: unknown): value is MediaRequest =>
  isRecord(value) &&
  value.type === "request" &&
  typeof value.id === "number" &&
  (value.method === "renew_commit" ||
    ((value.method === "offer" || value.method === "renew_offer") &&
      typeof value.offer === "string" &&
      value.offer.length > 0 &&
      value.offer.length <= 1_000_000));

const isMediaEvent = (value: unknown): value is MediaEvent =>
  isRecord(value) && value.type === "event" && typeof value.event === "string";

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
    if (typeof electronModule !== "string" || electronModule.length === 0) {
      throw new Error("Electron is not installed.");
    }
    const electronPath = electronModule;

    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      electronPath,
      [fileURLToPath(new URL("media", import.meta.url))],
      {
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
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
        new Error(
          `Voice media window exited during startup (${code ?? "unknown"}).`
        )
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
        this.rejectStartup(
          new Error("Voice media window did not start in time.")
        );
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
    if (!isRecord(message)) {
      return;
    }
    if (message.type === "event" && message.event === "ready") {
      this.resolveStartup();
      return;
    }

    if (isMediaRequest(message)) {
      void this.handleRequest(message);
      return;
    }
    if (isMediaEvent(message)) {
      this.handleEvent(message);
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
        this.options.onError(
          "OpenAI reports that voice usage is approaching its limit."
        );
        break;
      }
      default: {
        break;
      }
    }
  }

  private send(message: Record<string, unknown>): void {
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
