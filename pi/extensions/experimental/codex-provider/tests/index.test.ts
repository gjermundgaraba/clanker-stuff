import type { Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { CHECKPOINT_CUSTOM_TYPE } from "../checkpoint.js";
import extension from "../index.js";
import { createCodexLifecycle } from "../lifecycle.js";
import { SPIKE_MODEL } from "./fixtures.js";

vi.mock(import("../lifecycle.js"), { spy: true });

const OTHER_MODEL = {
  ...SPIKE_MODEL,
  api: "anthropic-messages",
  id: "claude-test",
  name: "Claude Test",
  provider: "anthropic",
} satisfies Model<"anthropic-messages">;

const createHost = (entries: SessionEntry[] = []) =>
  createExtensionHost(extension, {
    entries,
    leafId: entries.at(-1)?.id,
    model: OTHER_MODEL,
  });

describe("Codex lifecycle loading", () => {
  beforeEach(() => {
    vi.mocked(createCodexLifecycle).mockClear();
  });

  it("stays unloaded for non-Codex lifecycle hooks", async () => {
    const host = createHost();
    const ctx = host.createContext();

    await host.emitSessionStart(ctx);
    await host.emit(
      "before_agent_start",
      {
        prompt: "",
        systemPrompt: "",
        systemPromptOptions: {},
        type: "before_agent_start",
      },
      ctx,
    );
    await host.emit("context", { messages: [], type: "context" }, ctx);
    await host.emit(
      "before_provider_headers",
      { headers: {}, type: "before_provider_headers" },
      ctx,
    );
    await host.emit(
      "before_provider_request",
      { payload: {}, type: "before_provider_request" },
      ctx,
    );
    await host.emit(
      "session_before_compact",
      {
        branchEntries: [],
        customInstructions: undefined,
        preparation: {},
        type: "session_before_compact",
      },
      ctx,
    );

    expect(createCodexLifecycle).not.toHaveBeenCalled();
  });

  it("loads to protect a non-Codex branch containing a checkpoint", async () => {
    const checkpoint: SessionEntry = {
      customType: CHECKPOINT_CUSTOM_TYPE,
      data: {},
      id: "checkpoint",
      parentId: null,
      timestamp: new Date().toISOString(),
      type: "custom",
    };
    const host = createHost([checkpoint]);
    const ctx = host.createContext();

    await host.emitSessionStart(ctx);
    await host.emit("context", { messages: [], type: "context" }, ctx);

    expect(createCodexLifecycle).toHaveBeenCalledOnce();
  });

  it("does not load for a checkpoint shadowed by ordinary Pi compaction", async () => {
    const entries: SessionEntry[] = [
      {
        customType: CHECKPOINT_CUSTOM_TYPE,
        data: {},
        id: "checkpoint",
        parentId: null,
        timestamp: new Date().toISOString(),
        type: "custom",
      },
      {
        firstKeptEntryId: "checkpoint",
        id: "compaction",
        parentId: "checkpoint",
        summary: "ordinary Pi summary",
        timestamp: new Date().toISOString(),
        tokensBefore: 10,
        type: "compaction",
      },
    ];
    const host = createHost(entries);
    const ctx = host.createContext();

    await host.emitSessionStart(ctx);
    await host.emit("context", { messages: [], type: "context" }, ctx);

    expect(createCodexLifecycle).not.toHaveBeenCalled();
  });

  it("loads for a lifecycle checkpoint marker without parsing it eagerly", async () => {
    const checkpoint: SessionEntry = {
      details: { type: CHECKPOINT_CUSTOM_TYPE },
      firstKeptEntryId: "message",
      id: "compaction",
      parentId: null,
      summary: "opaque",
      timestamp: new Date().toISOString(),
      tokensBefore: 10,
      type: "compaction",
    };
    const host = createHost([checkpoint]);
    const ctx = host.createContext();

    await host.emitSessionStart(ctx);
    await host.emit("context", { messages: [], type: "context" }, ctx);

    expect(createCodexLifecycle).toHaveBeenCalledOnce();
  });
});
