import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { patchEnv } from "../helpers/env.js";
import { createTempDir } from "../helpers/fs.js";
import { createExtensionSmokeHarness } from "./extension-smoke.js";
import type { ExtensionSmokeHarness } from "./extension-smoke.js";

describe("extension-smoke harness", () => {
  let harness: ExtensionSmokeHarness | undefined;
  let restoreOuterHome: (() => void) | undefined;
  let ownedTempDirs: string[] = [];

  afterEach(async () => {
    harness?.cleanup();
    harness = undefined;
    restoreOuterHome?.();
    restoreOuterHome = undefined;
    await Promise.all(ownedTempDirs.map((dir) => rm(dir, { force: true, recursive: true })));
    ownedTempDirs = [];
  });

  it("discovers linked extensions, isolates HOME, and cleans up staged resources", async () => {
    const outerHome = await createTempDir("extension-smoke-outer-home-");
    ownedTempDirs.push(outerHome);
    await writeFile(path.join(outerHome, "leak.txt"), "outer-home");
    restoreOuterHome = patchEnv({ HOME: outerHome });

    const extensionDir = await createTempDir("extension-smoke-extension-");
    ownedTempDirs.push(extensionDir);
    await mkdir(extensionDir, { recursive: true });
    await writeFile(
      path.join(extensionDir, "index.ts"),
      `import { existsSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
    pi.on("input", (event) => ({
        action: "transform",
        text: \`[linked:\${existsSync(join(os.homedir(), "leak.txt")) ? "outer" : "isolated"}] \${event.text}\`,
    }));
}
`,
    );

    harness = await createExtensionSmokeHarness({
      extensions: [extensionDir],
    });
    const activeHarness = harness;
    activeHarness.setResponses([
      (context) => {
        const content = context.messages.findLast((message) => message.role === "user")?.content;
        const text = Array.isArray(content)
          ? content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
          : (content ?? "[non-string]");

        return fauxAssistantMessage(`seen:${text}`);
      },
    ]);

    await activeHarness.prompt("hello smoke");

    expect(
      activeHarness.extensionsResult.extensions.some(
        (extension) =>
          extension.resolvedPath ===
          path.join(
            activeHarness.projectDir,
            ".pi",
            "extensions",
            path.basename(extensionDir),
            "index.ts",
          ),
      ),
    ).toBeTruthy();
    expect(process.env.HOME).toBe(activeHarness.homeDir);
    expect(JSON.stringify(activeHarness.messages())).toContain("[linked:isolated] hello smoke");
    expect(JSON.stringify(activeHarness.messages())).not.toContain("[linked:outer]");

    const { homeDir, projectDir } = activeHarness;
    harness.cleanup();
    harness = undefined;

    expect({
      home: process.env.HOME,
      homeExists: existsSync(homeDir),
      projectExists: existsSync(projectDir),
    }).toStrictEqual({
      home: outerHome,
      homeExists: false,
      projectExists: false,
    });
  });
});
