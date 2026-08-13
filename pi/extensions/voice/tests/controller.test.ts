/* eslint-disable max-classes-per-file, vitest/prefer-import-in-mock */

import type {
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import extension from "../index.js";
import type { VoiceSessionOptions } from "../realtime.js";
import type { TranscriptEntry } from "../transcript.js";

interface FakeMediaProcess {
  startResult: PromiseWithResolvers<null>;
  stop: ReturnType<typeof vi.fn>;
}

interface FakeVoiceSession {
  dispose: ReturnType<typeof vi.fn>;
  options: VoiceSessionOptions;
  recentTranscript: ReturnType<typeof vi.fn<() => TranscriptEntry[]>>;
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
    readonly recentTranscript = vi.fn<() => TranscriptEntry[]>(() => []);
    readonly renewOffer = vi.fn<() => Promise<string>>(() =>
      Promise.resolve("")
    );
    readonly sendComplete = vi.fn<() => boolean>(() => true);
    readonly sendStatus = vi.fn<() => boolean>(() => true);
    readonly takeTranscriptTail = vi.fn<() => []>(() => []);

    readonly options: VoiceSessionOptions;

    constructor(options: VoiceSessionOptions) {
      this.options = options;
      fakes.voices.push(this);
    }
  },
}));

const createVoiceContext = (host: ReturnType<typeof createExtensionHost>) => {
  const model = { id: "coordinator", provider: "test" };
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "account-1",
      },
    })
  ).toString("base64url");
  return host.createContext({
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
};

describe("voice controller", () => {
  it("requires pi's interactive TUI mode", async () => {
    const host = createExtensionHost(extension);
    await expect(
      host.runShortcut("ctrl+shift+v", host.createContext({ mode: "json" }))
    ).rejects.toThrow("interactive TUI");
  });

  it("reports unavailable speech without an active call", async () => {
    const host = createExtensionHost(extension);
    const result = await host.runTool("speak_to_user", {
      message: "The tests need your approval.",
    });

    expect(result).toMatchObject({
      content: [{ text: "No active voice conversation was available." }],
      details: { delivered: false },
    });
  });

  it("reports unavailable voice ending without an active call", async () => {
    const host = createExtensionHost(extension);
    const result = await host.runTool("end_realtime_voice_call", {});

    expect(result).toMatchObject({
      content: [{ text: "No active realtime voice chat was available." }],
      details: { ended: false },
    });
  });

  it("keeps a visual result available when no voice handoff is active", async () => {
    const host = createExtensionHost(extension);
    const result = await host.runTool("present_voice_result", {
      markdown: "# Detailed result",
      spokenSummary: "The detailed result is in the terminal.",
    });

    expect(result).toMatchObject({
      content: [{ text: "No active voice conversation was available." }],
      details: { delivered: false, markdown: "# Detailed result" },
      terminate: false,
    });
  });

  it("starts with no footer status", async () => {
    const host = createExtensionHost(extension);
    const ctx = host.createContext();

    await host.emitSessionStart(ctx);

    expect(host.getStatus("voice")).toBeUndefined();
    expect(host.getActiveTools()).toStrictEqual([
      "read",
      "bash",
      "edit",
      "write",
    ]);
  });
});

describe("voice startup ownership", () => {
  beforeEach(() => {
    fakes.media.length = 0;
    fakes.voices.length = 0;
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
  });

  it("does not let a stopped startup tear down its replacement", async () => {
    const host = createExtensionHost(extension);
    const ctx = createVoiceContext(host);
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

  it("re-enables voice tools when media reconnects", async () => {
    const host = createExtensionHost(extension);
    const ctx = createVoiceContext(host);
    await host.emitSessionStart(ctx);

    const starting = host.runCommand("voice", "start", ctx);
    await vi.waitFor(() => expect(fakes.voices).toHaveLength(1));
    host.setActiveTools(["read", "bash", "edit", "write"]);
    const [activeVoice] = fakes.voices;
    const [activeMedia] = fakes.media;
    if (!(activeVoice && activeMedia)) {
      throw new Error("expected active voice session");
    }

    activeVoice.options.onState("active");

    expect(host.getActiveTools()).toStrictEqual([
      "read",
      "bash",
      "edit",
      "write",
      "speak_to_user",
      "present_voice_result",
      "end_realtime_voice_call",
    ]);
    activeMedia.startResult.resolve(null);
    await starting;
    await host.runCommand("voice", "stop", ctx);
  });

  it("keeps voice active when tree navigation does not complete", async () => {
    const host = createExtensionHost(extension);
    const ctx = createVoiceContext(host);
    await host.emitSessionStart(ctx);

    const starting = host.runCommand("voice", "start", ctx);
    await vi.waitFor(() => expect(fakes.voices).toHaveLength(1));
    const [activeVoice] = fakes.voices;
    const [activeMedia] = fakes.media;
    if (!(activeVoice && activeMedia)) {
      throw new Error("expected active voice session");
    }
    activeVoice.recentTranscript.mockReturnValue([
      { role: "user", text: "keep this call active" },
    ]);
    activeVoice.options.onState("active");
    activeMedia.startResult.resolve(null);
    await starting;

    await host.emit(
      "session_before_tree",
      { preparation: { oldLeafId: null }, type: "session_before_tree" },
      ctx
    );

    expect(activeMedia.stop).not.toHaveBeenCalled();
    expect(activeVoice.dispose).not.toHaveBeenCalled();
    expect(host.getActiveTools()).toContain("speak_to_user");
    await host.runCommand("voice", "stop", ctx);
  });

  it("restores continuity from the selected branch only", async () => {
    const root: SessionEntry = {
      id: "root",
      message: {
        content: "root",
        role: "user",
        timestamp: 1,
      },
      parentId: null,
      timestamp: new Date().toISOString(),
      type: "message",
    };
    const branchA: SessionEntry = {
      customType: "voice-continuity",
      data: { entries: [{ role: "user", text: "branch A" }] },
      id: "branch-a",
      parentId: root.id,
      timestamp: new Date().toISOString(),
      type: "custom",
    };
    const branchB: SessionEntry = {
      customType: "voice-continuity",
      data: { entries: [{ role: "assistant", text: "branch B" }] },
      id: "branch-b",
      parentId: root.id,
      timestamp: new Date().toISOString(),
      type: "custom",
    };
    const host = createExtensionHost(extension, {
      entries: [root, branchA, branchB],
      leafId: branchA.id,
    });
    const ctx = createVoiceContext(host);
    await host.emitSessionStart(ctx);

    const firstStart = host.runCommand("voice", "start", ctx);
    await vi.waitFor(() => expect(fakes.voices).toHaveLength(1));
    const [firstVoice] = fakes.voices;
    const [firstMedia] = fakes.media;
    if (!(firstVoice && firstMedia)) {
      throw new Error("expected first voice session");
    }
    expect(firstVoice.options.initialTranscript).toStrictEqual([
      { role: "user", text: "branch A" },
    ]);
    firstVoice.recentTranscript.mockReturnValue([
      { role: "user", text: "unsaved branch A" },
    ]);

    await host.emit(
      "session_before_tree",
      {
        preparation: { oldLeafId: branchA.id },
        type: "session_before_tree",
      },
      ctx
    );
    const continuityEntries = host
      .getAppendedEntries()
      .filter(
        (entry) =>
          entry.type === "custom" && entry.customType === "voice-continuity"
      );
    expect(continuityEntries.at(-1)).toMatchObject({
      data: { entries: [{ role: "user", text: "unsaved branch A" }] },
    });

    firstVoice.recentTranscript.mockReturnValue([
      { role: "user", text: "unsaved branch A" },
      { role: "assistant", text: "added during navigation" },
    ]);
    host.setLeafId(branchB.id);
    await host.emitSessionTree(ctx);
    expect(host.getAppendedEntries().at(-1)).toMatchObject({
      data: {
        branchId: branchA.id,
        entries: [
          { role: "user", text: "unsaved branch A" },
          { role: "assistant", text: "added during navigation" },
        ],
      },
    });
    firstMedia.startResult.resolve(null);
    await firstStart;

    const secondStart = host.runCommand("voice", "start", ctx);
    await vi.waitFor(() => expect(fakes.voices).toHaveLength(2));
    const [, secondVoice] = fakes.voices;
    const [, secondMedia] = fakes.media;
    if (!(secondVoice && secondMedia)) {
      throw new Error("expected second voice session");
    }
    expect(secondVoice.options.initialTranscript).toStrictEqual([
      { role: "assistant", text: "branch B" },
    ]);
    secondVoice.recentTranscript.mockReturnValue([
      { role: "assistant", text: "branch B" },
    ]);
    secondMedia.startResult.resolve(null);
    await secondStart;
    await host.runCommand("voice", "stop", ctx);

    host.setLeafId(branchA.id);
    await host.emitSessionTree(ctx);
    const thirdStart = host.runCommand("voice", "start", ctx);
    await vi.waitFor(() => expect(fakes.voices).toHaveLength(3));
    const thirdVoice = fakes.voices.at(2);
    const thirdMedia = fakes.media.at(2);
    if (!(thirdVoice && thirdMedia)) {
      throw new Error("expected restored voice session");
    }
    expect(thirdVoice.options.initialTranscript).toStrictEqual([
      { role: "user", text: "unsaved branch A" },
      { role: "assistant", text: "added during navigation" },
    ]);
    thirdMedia.startResult.resolve(null);
    await thirdStart;
    await host.runCommand("voice", "stop", ctx);
  });
});
