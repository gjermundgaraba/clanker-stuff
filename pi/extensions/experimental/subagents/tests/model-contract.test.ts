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
      researchIsNotPermission: root.includes("Requests for depth, thoroughness, research"),
      mailbox: root.includes("Message Type: MESSAGE | FINAL_ANSWER"),
    }).toStrictEqual({
      customUsage: true,
      defaultUsage: false,
      delegation: true,
      researchIsNotPermission: true,
      mailbox: true,
    });

    const child = v2ChildBasePrompt(config, "/root/review", "Sage");
    expect(child).toContain("You are V2 subagent Sage at /root/review.");
    expect(child).not.toContain("Complete the concrete assigned task");
    expect(v2ChildCapabilityPrompt(config)).toContain(
      "Use the eligible-child collaboration workflow.",
    );
  });

  it("gives V2 children collaboration guidance independent of model metadata", () => {
    const proactive = {
      ...structuredClone(DEFAULT_CONFIG),
      prompts: { delegation: "proactive" as const },
    };

    const prompt = v2ChildCapabilityPrompt(proactive);
    expect(prompt).toContain("Proactive multi-agent delegation is enabled.");
    expect(prompt).toContain("User requests override this hint.");
    expect(prompt).toContain("This V2 tree provides collaboration tools to its children.");
    expect(prompt).toContain("Permissions and concurrency limits still apply.");
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
    expect(v1SpawnDescription(DEFAULT_CONFIG)).toContain(
      "Do not set model or reasoning overrides unless the user explicitly asks",
    );
    expect(v2RootPrompt(DEFAULT_CONFIG, 3)).toContain(
      "Only set model or reasoning overrides when explicitly requested",
    );
    expect(v2RootPrompt(DEFAULT_CONFIG, 3)).toContain(
      "inherit the parent model and reasoning effort and do not accept overrides",
    );
  });

  it("describes the shared V2 interface without claiming identical coding tools", () => {
    expect(v2SpawnDescription()).toContain("share the tree's collaboration interface");
    expect(v2SpawnDescription()).not.toContain("same tools");
  });

  it("uses the supported Codex error envelope wording", () => {
    expect(formatV2ErrorCompletion("boom")).toBe(
      "Agent errored: boom\n\nThis agent's turn failed. If you still need this agent, use the available collaboration tools to give it another task.",
    );
  });
});
