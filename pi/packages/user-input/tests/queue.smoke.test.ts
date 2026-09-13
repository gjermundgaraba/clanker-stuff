import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vite-plus/test";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";

it("coordinates prompt queues across Pi's independently loaded extensions", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-prompt-loading-"));
  const queuePath = fileURLToPath(new URL("../queue.ts", import.meta.url));
  const paths = ["first", "second"].map((name) => join(cwd, `${name}.ts`));
  const hold = Promise.withResolvers<string>();
  try {
    await Promise.all(
      paths.map((path, index) =>
        writeFile(
          path,
          `import { runQueuedPrompt } from ${JSON.stringify(queuePath)};
export default function (pi) {
  pi.registerCommand("prompt-${index}", {
    description: "Prompt queue loading fixture",
    handler: (_args, ctx) => runQueuedPrompt(ctx, undefined,
      signal => ctx.ui.select("Prompt ${index}", ["Accept"], { signal })),
  });
}`,
        ),
      ),
    );
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      additionalExtensionPaths: paths,
      noExtensions: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noSkills: true,
      noThemes: true,
      settingsManager: SettingsManager.inMemory(),
    });
    await loader.reload();
    const { extensions, errors } = loader.getExtensions();
    expect(errors).toEqual([]);
    expect(extensions).toHaveLength(2);
    const first = extensions[0]!.commands.get("prompt-0")!;
    const second = extensions[1]!.commands.get("prompt-1")!;
    const select = vi
      .fn<ExtensionContext["ui"]["select"]>()
      .mockImplementationOnce(() => hold.promise)
      .mockResolvedValue("Accept");
    const ctx = createExtensionHost(() => {}).createContext({ ui: { select } });
    const firstPrompt = first.handler("", ctx);
    await expect.poll(() => select.mock.calls.length).toBe(1);
    const secondPrompt = second.handler("", ctx);
    // Drain queued microtasks and I/O: a second module-local queue would open now.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(select.mock.calls.map(([title]) => title)).toEqual(["Prompt 0"]);
    hold.resolve("Accept");
    await Promise.all([firstPrompt, secondPrompt]);
    expect(select.mock.calls.map(([title]) => title)).toEqual(["Prompt 0", "Prompt 1"]);
  } finally {
    hold.resolve("Accept");
    await rm(cwd, { recursive: true, force: true });
  }
});
