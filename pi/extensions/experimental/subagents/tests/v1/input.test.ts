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

  it("detects local images by content and rejects unsupported content", async () => {
    const cwd = await createTempDir("subagent-input-");
    await writeFile(
      path.join(cwd, "image.txt"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    await writeFile(path.join(cwd, "garbage.png"), "not an image");
    const bmp = Buffer.alloc(30);
    bmp.write("BM");
    bmp.writeUInt32LE(30, 2);
    bmp.writeUInt32LE(26, 10);
    bmp.writeUInt32LE(12, 14);
    bmp.writeUInt16LE(1, 22);
    bmp.writeUInt16LE(24, 24);
    await writeFile(path.join(cwd, "image.bmp"), bmp);

    await expect(
      prepareInput(undefined, [{ path: "image.txt", type: "local_image" }], cwd, [], true),
    ).resolves.toMatchObject({ images: [{ mimeType: "image/png", type: "image" }] });
    await expect(
      prepareInput(undefined, [{ path: "garbage.png", type: "local_image" }], cwd, [], true),
    ).rejects.toThrow("local_image must contain a PNG, JPEG, GIF, or WebP image");
    await expect(
      prepareInput(undefined, [{ path: "image.bmp", type: "local_image" }], cwd, [], true),
    ).rejects.toThrow("local_image must contain a PNG, JPEG, GIF, or WebP image");
  });
});
