import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createSyntheticSourceInfo } from "@earendil-works/pi-coding-agent";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import { createTempDir } from "../../../../../tests/helpers/fs.js";
import { prepareInput } from "../../v1/input.js";

describe(prepareInput, () => {
  it("expands discovered skills and rejects message/items ambiguity", async () => {
    const cwd = await createTempDir("subagent-input-");
    const skillDir = path.join(cwd, "skill");
    const skillPath = path.join(skillDir, "SKILL.md");
    await mkdir(skillDir);
    await writeFile(skillPath, "---\nname: demo\n---\nDo the thing.\n");
    const skill: Skill = {
      baseDir: skillDir,
      description: "",
      disableModelInvocation: false,
      filePath: skillPath,
      name: "demo",
      sourceInfo: createSyntheticSourceInfo(skillPath, { source: "test" }),
    };

    await expect(
      prepareInput(
        undefined,
        [{ name: "demo", path: skillPath, type: "skill" }],
        cwd,
        [skill],
        true,
      ),
    ).resolves.toStrictEqual({
      text: expect.stringContaining('<skill name="demo"'),
    });
    await expect(
      prepareInput("message", [{ text: "item", type: "text" }], cwd, [], true),
    ).rejects.toThrow("exactly one");
    await expect(prepareInput(undefined, undefined, cwd, [], true)).rejects.toThrow("exactly one");
  });
});
