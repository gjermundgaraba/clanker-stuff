import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import * as codingAgent from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import { registerCodexTools } from "../tools/register.js";
import { createToolsModel } from "./fixtures.js";

vi.mock(import("@earendil-works/pi-coding-agent"), { spy: true });

const tempDirectories: string[] = [];

const createTempDirectory = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-tools-"));
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
  it("applies Codex add, update, move, and delete patches", async () => {
    const cwd = await createTempDirectory();
    const model = createToolsModel("gpt-5.6-terra", true);
    const host = createExtensionHost(registerCodexTools, { model });
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
    const model = createToolsModel("gpt-5.6-terra", true);
    const host = createExtensionHost(registerCodexTools, { model });
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
    const model = createToolsModel("gpt-5.6-terra", true);
    const host = createExtensionHost(registerCodexTools, { model });
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
    const model = createToolsModel("gpt-5.6-terra", true);
    const host = createExtensionHost(registerCodexTools, { model });
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
    const model = createToolsModel("gpt-5.6-luna", true);
    const host = createExtensionHost(registerCodexTools, { model });
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

  it("rejects shells that reserve stdin for command transport", async () => {
    vi.spyOn(codingAgent, "getShellConfig").mockReturnValueOnce({
      args: ["-s"],
      commandTransport: "stdin",
      shell: process.execPath,
    });
    const model = createToolsModel("gpt-5.6-luna", true);
    const host = createExtensionHost(registerCodexTools, { model });
    await host.emitSessionStart();

    await expect(
      host.runTool("exec_command", { cmd: "printf unreachable" })
    ).rejects.toThrow("Shell stdin command transport is not supported");
  });

  it.skipIf(process.platform === "win32")(
    "bounds completion when a detached descendant holds the output pipes",
    async () => {
      const cwd = await createTempDirectory();
      const marker = path.join(cwd, "descendant.txt");
      const model = createToolsModel("gpt-5.6-luna", true);
      const host = createExtensionHost(registerCodexTools, { model });
      await host.emitSessionStart();
      const startedAt = Date.now();
      const descendant = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "alive"), 1200)`;

      const result = await host.runTool("exec_command", {
        cmd: `node -e ${JSON.stringify(`const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { detached: true, stdio: ["ignore", 1, 2] }); child.unref()`)}`,
        workdir: cwd,
      });

      expect(result.details).toMatchObject({ running: false });
      expect(Date.now() - startedAt).toBeLessThan(3000);
      await delay(500);
      await expect(readFile(marker, "utf-8")).resolves.toBe("alive");
    }
  );

  it("kills and forgets an aborted Codex process session", async () => {
    const model = createToolsModel("gpt-5.6-luna", true);
    const host = createExtensionHost(registerCodexTools, { model });
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

  it.skipIf(process.platform === "win32")(
    "kills a process still inside its initial yield during shutdown",
    async () => {
      const cwd = await createTempDirectory();
      const marker = path.join(cwd, "leaked.txt");
      const model = createToolsModel("gpt-5.6-luna", true);
      const host = createExtensionHost(registerCodexTools, { model });
      const ctx = host.createContext({ cwd, model });
      await host.emitSessionStart(ctx);

      const running = host.runTool(
        "exec_command",
        {
          cmd: `node -e ${JSON.stringify(`setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "leaked"), 1000)`)}`,
          yield_time_ms: 10_000,
        },
        ctx
      );
      await delay(100);
      await host.emitSessionShutdown(ctx);
      await running;
      await delay(1100);

      await expect(readFile(marker, "utf-8")).rejects.toThrow("ENOENT");
    }
  );

  it("bounds process output and preserves the full stream", async () => {
    const model = createToolsModel("gpt-5.6-luna", true);
    const host = createExtensionHost(registerCodexTools, { model });
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
