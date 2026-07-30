import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import { createExtensionHost } from "../../tests/harness/extension-host.js";
import extension from "../index.js";

const tempDirectories: string[] = [];

const createModel = (id: string, grammar = false) =>
  ({
    api: "openai-responses",
    baseUrl: "https://example.com",
    compat: grammar ? { supportsOpenAIGrammarTools: true } : undefined,
    contextWindow: 100_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id,
    input: ["text"],
    maxTokens: 10_000,
    name: id,
    provider: "test",
    reasoning: true,
  }) as Model<Api>;

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

  it("applies Codex add, update, move, and delete patches", async () => {
    const cwd = await createTempDirectory();
    const model = createModel("gpt-5.6-terra", true);
    const host = createExtensionHost(extension, { model });
    const ctx = host.createContext({ cwd, model });
    await host.emitSessionStart(ctx);

    await host.runTool(
      "apply_patch",
      {
        patch: [
          "*** Begin Patch",
          "*** Add File: example.txt",
          "+hello",
          "*** End Patch",
        ].join("\n"),
      },
      ctx
    );
    await writeFile(path.join(cwd, "delete.txt"), "remove me\n", "utf-8");
    await host.runTool(
      "apply_patch",
      {
        patch: [
          "*** Begin Patch",
          "*** Update File: example.txt",
          "*** Move to: moved.txt",
          "@@",
          "-hello",
          "+world",
          "*** Delete File: delete.txt",
          "*** End Patch",
        ].join("\n"),
      },
      ctx
    );

    await expect(readFile(path.join(cwd, "moved.txt"), "utf-8")).resolves.toBe(
      "world\n"
    );
    await expect(
      readFile(path.join(cwd, "example.txt"), "utf-8")
    ).rejects.toThrow("ENOENT");
    await expect(
      readFile(path.join(cwd, "delete.txt"), "utf-8")
    ).rejects.toThrow("ENOENT");
  });

  it("applies Codex move-only patches", async () => {
    const cwd = await createTempDirectory();
    await writeFile(path.join(cwd, "source.txt"), "unchanged\n", "utf-8");
    const model = createModel("gpt-5.6-terra", true);
    const host = createExtensionHost(extension, { model });
    const ctx = host.createContext({ cwd, model });
    await host.emitSessionStart(ctx);

    await host.runTool(
      "apply_patch",
      {
        patch: [
          "*** Begin Patch",
          "*** Update File: source.txt",
          "*** Move to: moved.txt",
          "*** End Patch",
        ].join("\n"),
      },
      ctx
    );

    await expect(readFile(path.join(cwd, "moved.txt"), "utf-8")).resolves.toBe(
      "unchanged\n"
    );
    await expect(
      readFile(path.join(cwd, "source.txt"), "utf-8")
    ).rejects.toThrow("ENOENT");
  });

  it("anchors Codex end-of-file hunks and rejects trailing hunk lines", async () => {
    const cwd = await createTempDirectory();
    const file = path.join(cwd, "example.txt");
    await writeFile(file, "target\nmiddle\ntarget\n", "utf-8");
    const model = createModel("gpt-5.6-terra", true);
    const host = createExtensionHost(extension, { model });
    const ctx = host.createContext({ cwd, model });
    await host.emitSessionStart(ctx);

    await host.runTool(
      "apply_patch",
      {
        patch: [
          "*** Begin Patch",
          "*** Update File: example.txt",
          "@@",
          "-target",
          "+last",
          "*** End of File",
          "*** End Patch",
        ].join("\n"),
      },
      ctx
    );

    await expect(readFile(file, "utf-8")).resolves.toBe(
      "target\nmiddle\nlast\n"
    );
    await host.runTool(
      "apply_patch",
      {
        patch: [
          "*** Begin Patch",
          "*** Update File: example.txt",
          "@@",
          "-target",
          "-middle",
          "-last",
          "*** End of File",
          "*** End Patch",
        ].join("\n"),
      },
      ctx
    );
    await expect(readFile(file, "utf-8")).resolves.toBe("");

    await expect(
      host.runTool(
        "apply_patch",
        {
          patch: [
            "*** Begin Patch",
            "*** Update File: example.txt",
            "@@",
            "-last",
            "+invalid",
            "*** End of File",
            "+trailing",
            "*** End Patch",
          ].join("\n"),
        },
        ctx
      )
    ).rejects.toThrow("End-of-file marker must end the update");
  });

  it("does not start an already-aborted Codex patch", async () => {
    const cwd = await createTempDirectory();
    const model = createModel("gpt-5.6-terra", true);
    const host = createExtensionHost(extension, { model });
    const ctx = host.createContext({ cwd, model });
    const controller = new AbortController();
    controller.abort();
    await host.emitSessionStart(ctx);

    await expect(
      host.runTool(
        "apply_patch",
        {
          patch: [
            "*** Begin Patch",
            "*** Add File: example.txt",
            "+hello",
            "*** End Patch",
          ].join("\n"),
        },
        { ctx, signal: controller.signal }
      )
    ).rejects.toThrow("Operation aborted");
    await expect(
      readFile(path.join(cwd, "example.txt"), "utf-8")
    ).rejects.toThrow("ENOENT");
  });

  it("runs and continues Codex process sessions", async () => {
    const model = createModel("gpt-5.6-luna", true);
    const host = createExtensionHost(extension, { model });
    await host.emitSessionStart();

    const started = await host.runTool("exec_command", {
      cmd: "read value; printf 'got:%s' \"$value\"",
      yield_time_ms: 0,
    });
    const details = started.details as { sessionId?: number };
    expect(details.sessionId).toBeTypeOf("number");
    expect(textContent(started)).toContain(`Session ID: ${details.sessionId}`);

    const finished = await host.runTool("write_stdin", {
      chars: "hello\n",
      session_id: details.sessionId,
      yield_time_ms: 1000,
    });

    expect(textContent(finished)).toContain("got:hello");
    expect(textContent(finished)).toContain("Process exited with code 0");
  });

  it("kills and forgets an aborted Codex process session", async () => {
    const model = createModel("gpt-5.6-luna", true);
    const host = createExtensionHost(extension, { model });
    await host.emitSessionStart();

    const started = await host.runTool("exec_command", {
      cmd: "read value",
      yield_time_ms: 0,
    });
    const { sessionId } = started.details as { sessionId?: number };
    if (!sessionId) {
      throw new Error("Process session ID was not returned");
    }
    const controller = new AbortController();
    controller.abort();

    await expect(
      host.runTool(
        "write_stdin",
        { session_id: sessionId, yield_time_ms: 0 },
        { signal: controller.signal }
      )
    ).rejects.toThrow("Operation aborted");
    await expect(
      host.runTool("write_stdin", {
        session_id: sessionId,
        yield_time_ms: 0,
      })
    ).rejects.toThrow(`Unknown process session: ${sessionId}`);
  });

  it("bounds process output and preserves the full stream", async () => {
    const model = createModel("gpt-5.6-luna", true);
    const host = createExtensionHost(extension, { model });
    await host.emitSessionStart();

    const result = await host.runTool("exec_command", {
      cmd: `node -e "for(let i=0;i<3000;i++) console.log('line')"`,
    });
    const details = result.details as {
      fullOutputPath?: string;
      truncation?: { truncated: boolean };
    };

    expect(details.truncation?.truncated).toBeTruthy();
    expect(details.fullOutputPath).toBeTypeOf("string");
    expect(textContent(result)).toContain("Output truncated");
    const { fullOutputPath } = details;
    if (!fullOutputPath) {
      throw new Error("Full output path was not returned");
    }
    await expect(readFile(fullOutputPath, "utf-8")).resolves.toContain(
      "line\nline\n"
    );
    await rm(fullOutputPath);
  });
});
