import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_CONFIG } from "../config.js";
import {
  formatV2ErrorCompletion,
  v1ChildPrompt,
  v1RootPrompt,
  v1SpawnDescription,
  v2ChildBasePrompt,
  v2ChildCapabilityPrompt,
  v2RootPrompt,
  v2SpawnDescription,
} from "../model-contract.js";

describe("Pi model-facing collaboration contract", () => {
  it("keeps delegation policy separate from replaceable root usage hints", () => {
    const config = {
      ...structuredClone(DEFAULT_CONFIG),
      prompts: {
        child: "",
        delegation: "explicit" as const,
        v2: {
          child: "Use the eligible-child collaboration workflow.",
          root: "Use the project-specific delegation workflow.",
        },
      },
    };

    const root = v2RootPrompt(config, 2);
    expect({
      customUsage: root.includes("Use the project-specific delegation workflow."),
      defaultUsage: root.includes("Keep immediate blockers local"),
      delegation: root.includes("Explicit delegation is enabled."),
      mailbox: root.includes("Message Type: MESSAGE | FINAL_ANSWER"),
    }).toStrictEqual({
      customUsage: true,
      defaultUsage: false,
      delegation: true,
      mailbox: true,
    });

    const child = v2ChildBasePrompt(config, "/root/review", "Sage");
    expect(child).toContain("You are V2 subagent Sage at /root/review.");
    expect(child).not.toContain("Complete the concrete assigned task");
    expect(v2ChildCapabilityPrompt(config, true)).toContain(
      "Use the eligible-child collaboration workflow.",
    );
    expect(v2ChildCapabilityPrompt(config, false)).not.toContain(
      "Use the eligible-child collaboration workflow.",
    );
  });

  it("generates capability-dependent V2 child guidance", () => {
    const proactive = {
      ...structuredClone(DEFAULT_CONFIG),
      prompts: { delegation: "proactive" as const },
    };

    expect(v2ChildCapabilityPrompt(proactive, true)).toContain("Proactive delegation is enabled.");
    expect(v2ChildCapabilityPrompt(proactive, true)).toContain(
      "Descendants receive these tools only when their own resolved models declare V2.",
    );
    const ineligible = v2ChildCapabilityPrompt(proactive, false);
    expect(ineligible).toContain("does not provide V2 collaboration tools");
    expect(ineligible).not.toContain("spawn_agent");
  });

  it("states the flat V1 capability and bounded delegation policy", () => {
    const root = v1RootPrompt(DEFAULT_CONFIG, 4);
    expect(root).toContain("V1 children are UUID-addressed");
    expect(root).toContain("At most 4 agents can be open");
    expect(root).toContain("Explicit delegation is enabled.");

    expect(v1ChildPrompt(DEFAULT_CONFIG, "agent-id", "Atlas")).toContain(
      "You do not have collaboration tools.",
    );
    expect(v1SpawnDescription(DEFAULT_CONFIG)).toContain(
      "Delegate non-blocking work with a clear, disjoint scope.",
    );
  });

  it("never promises uniform child tools in the V2 spawn description", () => {
    expect(v2SpawnDescription()).toContain("only when its resolved model declares V2");
    expect(v2SpawnDescription()).not.toContain("same tools");
  });

  it("uses the supported Codex error envelope wording", () => {
    expect(formatV2ErrorCompletion("boom")).toBe(
      "Agent errored: boom\n\nThis agent's turn failed. If you still need this agent, use the available collaboration tools to give it another task.",
    );
  });
});
