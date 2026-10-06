import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_CONFIG } from "../config.js";
import { childPrompt, errorCompletion, FORK_TURNS_DESCRIPTION, rootPrompt } from "../prompts.js";

describe("model-facing collaboration prompts", () => {
  it("states the configured tree-wide limit, root identity and mailbox", () => {
    const root = rootPrompt({ ...DEFAULT_CONFIG, maxConcurrent: 2 }, "explicit");

    expect(root).toContain("You are /root");
    expect(root).toContain("At most 2 child runtimes");
    expect(root).toContain("across the whole tree");
    expect(root).toContain("The root does not consume a slot");
    expect(root).toContain("Message Type: MESSAGE | FINAL_ANSWER");
  });

  it("gives children their identity, shared limit and task mailbox", () => {
    const child = childPrompt({ ...DEFAULT_CONFIG, maxConcurrent: 2 }, "/root/review", "explicit");

    expect(child).toContain("You are subagent /root/review.");
    expect(child).toContain("At most 2 child runtimes");
    expect(child).toContain("each active child occupies one");
    expect(child).toContain("Message Type: NEW_TASK | MESSAGE | FINAL_ANSWER");
  });

  it.each([
    { delegation: "explicit", policy: "explicit", proactive: false },
    { delegation: "explicit", policy: "proactive", proactive: true },
    { delegation: "proactive", policy: "explicit", proactive: false },
    { delegation: "proactive", policy: "proactive", proactive: true },
  ] as const)(
    "publishes the branch permission without overriding user/project constraints (default=$delegation, policy=$policy)",
    ({ delegation, policy, proactive }) => {
      const config = { ...DEFAULT_CONFIG, delegation };

      for (const prompt of [
        rootPrompt(config, policy),
        childPrompt(config, "/root/worker", policy),
      ]) {
        expect(prompt).toContain("Only set model or reasoning_effort");
        expect(prompt).toContain(
          "user, applicable project instructions, or a skill explicitly requests",
        );

        if (proactive) {
          expect(prompt).toContain("Proactive multi-agent delegation is enabled");
          expect(prompt).toContain("permission does not override user instructions");
          expect(prompt).toContain("applicable project/skill constraints");
          expect(prompt).toContain("delegate concrete independent tasks");
          expect(prompt).not.toContain("Spawn an agent only when");
        } else {
          expect(prompt).toContain("Spawn an agent only when");
          expect(prompt).toContain("Requests for depth, thoroughness, research");
          expect(prompt).not.toContain("Proactive multi-agent delegation is enabled");
        }
      }
    },
  );

  it("makes omitted fork evidence explicit even for all turns", () => {
    expect(FORK_TURNS_DESCRIPTION).toMatch(
      /tool calls\/results and intermediate assistant responses are omitted.*even with "all"/iu,
    );
    expect(FORK_TURNS_DESCRIPTION).toContain(
      "include required findings and decision context in message",
    );
  });

  it("uses the Codex error-envelope prefix", () => {
    expect(errorCompletion("boom")).toMatch(/^Agent errored: boom\n\n/u);
  });
});
