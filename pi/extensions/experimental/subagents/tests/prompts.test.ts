import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_CONFIG } from "../config.js";
import { childPrompt, errorCompletion, rootPrompt } from "../prompts.js";

describe("model-facing collaboration prompts", () => {
  it("states delegation policy, concurrency, and the root mailbox", () => {
    const root = rootPrompt({ ...DEFAULT_CONFIG, maxConcurrent: 2 });

    expect(root).toContain("At most 2 children can run or shut down at once.");
    expect(root).toContain("Explicit delegation is enabled.");
    expect(root).toContain("Requests for depth, thoroughness, research");
    expect(root).toContain("Message Type: MESSAGE | FINAL_ANSWER");
    expect(rootPrompt({ ...DEFAULT_CONFIG, delegation: "proactive" })).toContain(
      "Proactive multi-agent delegation is enabled.",
    );
  });

  it("sets model overrides only on explicit request", () => {
    expect(rootPrompt(DEFAULT_CONFIG)).toContain(
      "Only set model or reasoning_effort when the user, applicable project instructions, or a skill explicitly requests it.",
    );
  });

  it("gives children their identity, collaboration tools, and the task mailbox", () => {
    const child = childPrompt(DEFAULT_CONFIG, "/root/review");

    expect(child).toContain("You are subagent /root/review.");
    expect(child).toContain("You have the same collaboration tools as your parent.");
    expect(child).toContain("Message Type: NEW_TASK | MESSAGE | FINAL_ANSWER");
  });

  it("uses the supported Codex error envelope wording", () => {
    expect(errorCompletion("boom")).toBe(
      "Agent errored: boom\n\nThis agent's turn failed. If you still need this agent, use the available collaboration tools to give it another task.",
    );
  });
});
