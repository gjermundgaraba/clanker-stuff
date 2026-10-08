import { initTheme } from "@earendil-works/pi-coding-agent";
import { resetCapabilitiesCache, setCapabilities, Text } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { createIdentityTheme, createMockTui } from "../../../../../tests/harness/tui.js";
import type { AgentMessage } from "../../runtime.js";
import { Transcript } from "../../ui/transcript.js";

/** A 1×1 PNG. */
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const calls: AgentMessage = {
  api: "faux",
  content: [
    { arguments: { path: "fast.txt" }, id: "fast", name: "read", type: "toolCall" },
    { arguments: { path: "slow.txt" }, id: "slow", name: "read", type: "toolCall" },
  ],
  model: "child",
  provider: "provider",
  role: "assistant",
  stopReason: "toolUse",
  timestamp: 0,
  usage: {
    cacheRead: 0,
    cacheWrite: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input: 0,
    output: 0,
    totalTokens: 0,
  },
};

const result = (
  toolCallId: string,
  content: Extract<AgentMessage, { role: "toolResult" }>["content"],
): AgentMessage => ({
  content,
  isError: false,
  role: "toolResult",
  timestamp: 0,
  toolCallId,
  toolName: "read",
});

const transcript = () =>
  new Transcript({
    cwd: "/project",
    renderers: () => undefined,
    theme: createIdentityTheme(),
    tui: createMockTui({ rows: 40 }),
  });

const text = (component: Transcript) => component.render(100).join("\n");

beforeAll(() => initTheme("dark"));

afterEach(() => resetCapabilitiesCache());

describe(Transcript, () => {
  it("shows results of calls that finished before it was opened mid-batch", () => {
    // The fast call has finished; Pi emits its result message only when the whole batch ends.
    const component = transcript();
    component.load([calls], undefined, new Set(["slow"]));

    component.handle({
      message: result("fast", [{ text: "FAST-RESULT", type: "text" }]),
      type: "message_start",
    });
    component.handle({
      message: result("slow", [{ text: "SLOW-RESULT", type: "text" }]),
      type: "message_start",
    });

    expect(text(component)).toContain("FAST-RESULT");
    expect(text(component)).toContain("SLOW-RESULT");
  });

  it("settles running rows when disposed, so their renderers can stop timers", () => {
    const renderResult = vi.fn(() => new Text("", 0, 0));

    const component = new Transcript({
      cwd: "/project",
      renderers: () => ({ renderResult }),
      theme: createIdentityTheme(),
      tui: createMockTui({ rows: 40 }),
    });

    component.load([calls], undefined, new Set(["slow"]));
    component.handle({
      args: { path: "slow.txt" },
      partialResult: { content: [{ text: "partial", type: "text" }] },
      toolCallId: "slow",
      toolName: "read",
      type: "tool_execution_update",
    });
    expect(renderResult).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ isPartial: true }),
      expect.anything(),
      expect.anything(),
    );

    component.dispose();
    expect(renderResult).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ isPartial: false }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("describes image results in text even where the terminal can draw images", () => {
    setCapabilities({ hyperlinks: true, images: "kitty", trueColor: true });
    const component = transcript();
    component.load(
      [calls, result("fast", [{ data: PIXEL, mimeType: "image/png", type: "image" }])],
      undefined,
    );

    expect(text(component)).toContain("[Image: [image/png] 1x1]");
  });
});
