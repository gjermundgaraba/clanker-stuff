import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { loadSkills } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

const ORCHESTRATE_SKILL_PATH = fileURLToPath(
  new URL("../vendor/orchestrate/SKILL.md", import.meta.url),
);

describe("orchestrate skill", () => {
  it("keeps valid metadata and capability-safe V1/V2 guidance for explicit loading", async () => {
    const loaded = loadSkills({
      agentDir: import.meta.dirname,
      cwd: import.meta.dirname,
      includeDefaults: false,
      skillPaths: [ORCHESTRATE_SKILL_PATH],
    });

    expect(loaded.diagnostics).toStrictEqual([]);
    expect(loaded.skills).toMatchObject([
      {
        description:
          "Coordinate multiple agents on large-scope tasks. Use whenever the work is substantial; trivial tasks do not require this skill.",
        filePath: ORCHESTRATE_SKILL_PATH,
        name: "orchestrate",
      },
    ]);

    const contents = await readFile(ORCHESTRATE_SKILL_PATH, "utf-8");
    expect({
      conditionalOverride: contents.includes("When `spawn_agent` exposes `reasoning_effort`"),
      omissionFallback: contents.includes("otherwise omit that field"),
      v1Fork: contents.includes(
        "when it exposes `fork_context`, omit `fork_context` or set it to `false`",
      ),
      v2Fork: contents.includes('use `fork_turns: "none"` when `spawn_agent` exposes `fork_turns`'),
    }).toStrictEqual({
      conditionalOverride: true,
      omissionFallback: true,
      v1Fork: true,
      v2Fork: true,
    });
    await expect(
      readFile(new URL("../vendor/orchestrate/LICENSE", import.meta.url), "utf-8"),
    ).resolves.toContain("Copyright (c) 2026 Eric Provencher");
    await expect(
      readFile(new URL("../vendor/orchestrate/UPSTREAM", import.meta.url), "utf-8"),
    ).resolves.toContain("1fe93e920cbd99173eedd22e94d10d49e2c76da7");
  });
});
