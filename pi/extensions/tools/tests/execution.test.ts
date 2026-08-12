import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import extension from "../index.js";
import { createModel } from "./fixtures.js";

const tempDirectories: string[] = [];

const createTempDirectory = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "tools-extension-"));
  tempDirectories.push(directory);
  return directory;
};

const textContent = (
  result: Awaited<ReturnType<ReturnType<typeof createExtensionHost>["runTool"]>>
) =>
  result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");

describe("profile execution", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirectories.splice(0).map(async (directory) => {
        await rm(directory, { force: true, recursive: true });
      })
    );
  });
  it("translates Kimi replace_all into one queued file mutation", async () => {
    const cwd = await createTempDirectory();
    const file = path.join(cwd, "example.txt");
    await writeFile(file, "old and old\n", "utf-8");
    const host = createExtensionHost(extension, {
      model: createModel("kimi-k3"),
    });
    const ctx = host.createContext({ cwd, model: createModel("kimi-k3") });
    await host.emitSessionStart(ctx);

    const result = await host.runTool(
      "Edit",
      {
        new_string: "new",
        old_string: "old",
        path: file,
        replace_all: true,
      },
      ctx
    );

    await expect(readFile(file, "utf-8")).resolves.toBe("new and new\n");
    expect(result.details).toMatchObject({ replacementCount: 2 });
  });

  it("adapts Kimi append writes", async () => {
    const cwd = await createTempDirectory();
    const file = path.join(cwd, "append.txt");
    const model = createModel("kimi-k3");
    const host = createExtensionHost(extension, { model });
    const ctx = host.createContext({ cwd, model });
    await host.emitSessionStart(ctx);

    await host.runTool(
      "Write",
      { content: "first\n", mode: "append", path: file },
      ctx
    );
    const appended = await host.runTool(
      "Write",
      { content: "second\n", mode: "append", path: file },
      ctx
    );

    await expect(readFile(file, "utf-8")).resolves.toBe("first\nsecond\n");
    expect(appended.details).toMatchObject({ bytes: 7, mode: "append" });
  });

  it("adapts Kimi multiline grep", async () => {
    const cwd = await createTempDirectory();
    await writeFile(
      path.join(cwd, "example.txt"),
      "first line\nsecond line\nthird line\n",
      "utf-8"
    );
    const model = createModel("kimi-k3");
    const host = createExtensionHost(extension, { model });
    const ctx = host.createContext({ cwd, model });
    await host.emitSessionStart(ctx);

    const result = await host.runTool(
      "Grep",
      {
        multiline: true,
        path: cwd,
        pattern: "first line\\nsecond line",
      },
      ctx
    );

    expect(textContent(result)).toContain("example.txt:1:first line");
    expect(textContent(result)).toContain("example.txt:2:second line");

    const count = await host.runTool(
      "Grep",
      { output_mode: "count", path: cwd, pattern: "line" },
      ctx
    );
    expect(textContent(count)).toContain("example.txt:3");
  });

  it("runs and bounds non-Codex shell output", async () => {
    const model = createModel("kimi-k3");
    const host = createExtensionHost(extension, { model });
    await host.emitSessionStart();

    const result = await host.runTool("Bash", {
      command: `node -e "for(let i=0;i<3000;i++) console.log('line')"`,
    });
    const details = result.details as {
      fullOutputPath?: string;
      truncation?: { truncated: boolean };
    };

    expect(details.truncation?.truncated).toBeTruthy();
    expect(details.fullOutputPath).toBeTypeOf("string");
    expect(textContent(result)).toContain("Full output:");
    if (!details.fullOutputPath) {
      throw new Error("Full output path was not returned");
    }
    await expect(readFile(details.fullOutputPath, "utf-8")).resolves.toContain(
      "line\nline\n"
    );
    await rm(details.fullOutputPath);
  });
});
