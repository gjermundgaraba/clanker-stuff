import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import extension from "../index.js";
import { createModel } from "./fixtures.js";

const tempDirectories: string[] = [];
const BashDetailsSchema = Type.Object({
  fullOutputPath: Type.String(),
  truncation: Type.Object({ truncated: Type.Boolean() }),
});

const createTempDirectory = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "tools-extension-"));
  tempDirectories.push(directory);
  return directory;
};

const textContent = (
  result: Awaited<ReturnType<ReturnType<typeof createExtensionHost>["runTool"]>>,
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
      }),
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
      ctx,
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

    await host.runTool("Write", { content: "first\n", mode: "append", path: file }, ctx);
    const appended = await host.runTool(
      "Write",
      { content: "second\n", mode: "append", path: file },
      ctx,
    );

    await expect(readFile(file, "utf-8")).resolves.toBe("first\nsecond\n");
    expect(appended.details).toMatchObject({ bytes: 7, mode: "append" });
  });

  it("adapts Kimi multiline grep", async () => {
    const cwd = await createTempDirectory();
    await writeFile(
      path.join(cwd, "example.txt"),
      "first line\nsecond line\nthird line\n",
      "utf-8",
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
      ctx,
    );

    expect(textContent(result)).toContain("example.txt:1:first line");
    expect(textContent(result)).toContain("example.txt:2:second line");

    const count = await host.runTool(
      "Grep",
      { head_limit: 1, output_mode: "count", path: cwd, pattern: "line" },
      ctx,
    );
    expect(textContent(count)).toContain("example.txt:3");
  });

  it("keeps grep before and after context asymmetric", async () => {
    const cwd = await createTempDirectory();
    await writeFile(
      path.join(cwd, "context.txt"),
      "before two\nbefore one\nmatch\nafter one\nafter two\n",
      "utf-8",
    );
    const model = createModel("claude-sonnet-5");
    const host = createExtensionHost(extension, { model });
    const ctx = host.createContext({ cwd, model });
    await host.emitSessionStart(ctx);

    const result = await host.runTool(
      "Grep",
      {
        "-A": 1,
        "-B": 2,
        path: cwd,
        pattern: "match",
      },
      ctx,
    );
    const output = textContent(result);

    expect(output).toContain("before two");
    expect(output).toContain("before one");
    expect(output).toContain("after one");
    expect(output).not.toContain("after two");
  });

  it("merges adjacent matches with context and preserves explicit zero", async () => {
    const cwd = await createTempDirectory();
    await writeFile(
      path.join(cwd, "context.txt"),
      "before\nmatch one\nmatch two\nafter\n",
      "utf-8",
    );
    const model = createModel("claude-sonnet-5");
    const host = createExtensionHost(extension, { model });
    const ctx = host.createContext({ cwd, model });
    await host.emitSessionStart(ctx);

    const symmetric = textContent(
      await host.runTool("Grep", { "-C": 1, path: cwd, pattern: "match" }, ctx),
    );
    expect({
      firstMatches: symmetric.match(/match one/gu)?.length,
      secondMatches: symmetric.match(/match two/gu)?.length,
    }).toStrictEqual({ firstMatches: 1, secondMatches: 1 });
    expect(symmetric).toStrictEqual(expect.stringContaining("context.txt:2:match one"));

    const singleFile = textContent(
      await host.runTool(
        "Grep",
        { "-C": 1, path: path.join(cwd, "context.txt"), pattern: "match" },
        ctx,
      ),
    );
    expect({ output: singleFile, secondMatch: symmetric }).toMatchObject({
      output: expect.not.stringContaining(cwd),
      secondMatch: expect.stringContaining("context.txt:3:match two"),
    });

    const zeroAfter = textContent(
      await host.runTool("Grep", { "-A": 0, "-C": 1, path: cwd, pattern: "match one" }, ctx),
    );
    expect({
      hasBefore: zeroAfter.includes("before"),
      output: zeroAfter,
    }).toMatchObject({
      hasBefore: true,
      output: expect.not.stringContaining("match two"),
    });

    const zeroBoth = textContent(
      await host.runTool(
        "Grep",
        {
          "-A": 0,
          "-B": 0,
          "-C": 1,
          path: cwd,
          pattern: "match one",
        },
        ctx,
      ),
    );
    expect(zeroBoth).not.toContain("before");
  });

  it("applies the grep head limit globally without dropping context", async () => {
    const cwd = await createTempDirectory();
    await Promise.all(
      ["a.txt", "b.txt"].map(
        async (file) => await writeFile(path.join(cwd, file), "before\nneedle\nafter\n", "utf-8"),
      ),
    );
    const model = createModel("claude-sonnet-5");
    const host = createExtensionHost(extension, { model });
    const ctx = host.createContext({ cwd, model });
    await host.emitSessionStart(ctx);

    const output = textContent(
      await host.runTool("Grep", { "-C": 1, head_limit: 1, path: cwd, pattern: "needle" }, ctx),
    );

    expect(output.match(/needle/gu)).toHaveLength(1);
    expect(output).toContain("before");
    expect(output).toContain("after");

    const adjacent = textContent(
      await host.runTool(
        "Grep",
        {
          "-A": 2,
          head_limit: 1,
          path: cwd,
          pattern: "before|needle",
        },
        ctx,
      ),
    );
    expect(adjacent.match(/before|needle/gu)).toHaveLength(1);
  });

  it("renders grep matches from non-UTF-8 files", async () => {
    const cwd = await createTempDirectory();
    await writeFile(path.join(cwd, "bytes.txt"), Buffer.from([0xff, ...Buffer.from("needle\n")]));
    const model = createModel("claude-sonnet-5");
    const host = createExtensionHost(extension, { model });
    const ctx = host.createContext({ cwd, model });
    await host.emitSessionStart(ctx);

    const output = textContent(
      await host.runTool("Grep", { "-C": 1, path: cwd, pattern: "needle" }, ctx),
    );

    expect(output).toContain("needle");
  });

  it("bounds oversized newline-free grep records", async () => {
    const cwd = await createTempDirectory();
    await writeFile(
      path.join(cwd, "long.txt"),
      `needle${"x".repeat(DEFAULT_MAX_BYTES * 3)}`,
      "utf-8",
    );
    const model = createModel("claude-sonnet-5");
    const host = createExtensionHost(extension, { model });
    const ctx = host.createContext({ cwd, model });
    await host.emitSessionStart(ctx);

    const result = await host.runTool("Grep", { "-C": 1, path: cwd, pattern: "needle" }, ctx);
    const output = textContent(result);

    expect(Buffer.byteLength(output)).toBeLessThan(DEFAULT_MAX_BYTES);
    expect(output).toContain("Output byte limit reached");
    expect(output).not.toContain("needle");
  });

  it("runs and bounds non-Codex shell output", async () => {
    const model = createModel("kimi-k3");
    const host = createExtensionHost(extension, { model });
    await host.emitSessionStart();

    const result = await host.runTool("Bash", {
      command: `node -e "for(let i=0;i<3000;i++) console.log('line')"`,
    });
    const details = Value.Parse(BashDetailsSchema, result.details);

    expect(details.truncation?.truncated).toBeTruthy();
    expect(details.fullOutputPath).toBeTypeOf("string");
    expect(textContent(result)).toContain("Full output:");
    await expect(readFile(details.fullOutputPath, "utf-8")).resolves.toContain("line\nline\n");
    await rm(details.fullOutputPath);
  });
});
