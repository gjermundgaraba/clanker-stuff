/* eslint-disable max-classes-per-file, vitest/prefer-import-in-mock */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../tests/harness/extension-host.js";
import extension from "../index.js";

interface FakeMediaProcess {
  startResult: PromiseWithResolvers<null>;
  stop: ReturnType<typeof vi.fn>;
}

interface FakeVoiceSession {
  dispose: ReturnType<typeof vi.fn>;
}

const fakes = vi.hoisted(() => ({
  media: [] as FakeMediaProcess[],
  voices: [] as FakeVoiceSession[],
}));

vi.mock("../media-process.js", () => ({
  MediaProcess: class {
    readonly requestRenewal = vi.fn<() => void>();
    readonly sendError = vi.fn<() => void>();
    readonly sendState = vi.fn<() => void>();
    readonly start = vi.fn<() => Promise<null>>(() => this.startResult.promise);
    readonly startResult = Promise.withResolvers<null>();
    readonly stop = vi.fn<() => void>();

    constructor() {
      fakes.media.push(this);
    }
  },
}));

vi.mock("../realtime.js", () => ({
  VoiceSession: class {
    readonly abortRenew = vi.fn<() => void>();
    readonly acceptOffer = vi.fn<() => Promise<string>>(() =>
      Promise.resolve("")
    );
    readonly commitRenew = vi.fn<() => Promise<void>>(() => Promise.resolve());
    readonly dispose = vi.fn<() => void>();
    readonly endCall = vi.fn<() => void>();
    readonly recentTranscript = vi.fn<() => []>(() => []);
    readonly renewOffer = vi.fn<() => Promise<string>>(() =>
      Promise.resolve("")
    );
    readonly sendComplete = vi.fn<() => boolean>(() => true);
    readonly sendStatus = vi.fn<() => boolean>(() => true);
    readonly takeTranscriptTail = vi.fn<() => []>(() => []);

    constructor() {
      fakes.voices.push(this);
    }
  },
}));

describe("voice startup ownership", () => {
  beforeEach(() => {
    fakes.media.length = 0;
    fakes.voices.length = 0;
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not let a stopped startup tear down its replacement", async () => {
    const host = createExtensionHost(extension);
    const model = { id: "coordinator", provider: "test" };
    const payload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "account-1",
        },
      })
    ).toString("base64url");
    const ctx = host.createContext({
      model: model as ExtensionContext["model"],
      modelRegistry: {
        getAll: () => [model],
        getApiKeyAndHeaders: async () => {
          await Promise.resolve();
          return { ok: true };
        },
        getProviderAuth: async () => {
          await Promise.resolve();
          return { auth: { apiKey: `x.${payload}.x` } };
        },
      } as unknown as ExtensionContext["modelRegistry"],
    });
    await host.emitSessionStart(ctx);

    const firstStart = host.runCommand("voice", "start", ctx);
    await vi.waitFor(() => {
      expect(fakes.media).toHaveLength(1);
    });
    expect(host.getActiveTools()).toStrictEqual([
      "read",
      "bash",
      "edit",
      "write",
      "speak_to_user",
      "present_voice_result",
      "end_realtime_voice_call",
    ]);
    await host.runCommand("voice", "stop", ctx);
    expect(host.getActiveTools()).toStrictEqual([
      "read",
      "bash",
      "edit",
      "write",
    ]);

    const secondStart = host.runCommand("voice", "start", ctx);
    await vi.waitFor(() => {
      expect(fakes.media).toHaveLength(2);
    });
    fakes.media[0]?.startResult.reject(new Error("stopped"));

    await expect(firstStart).resolves.toBeUndefined();
    expect(fakes.media[1]?.stop).not.toHaveBeenCalled();
    expect(fakes.voices[1]?.dispose).not.toHaveBeenCalled();

    fakes.media[1]?.startResult.resolve(null);
    await secondStart;
    await host.runCommand("voice", "stop", ctx);
  });
});
