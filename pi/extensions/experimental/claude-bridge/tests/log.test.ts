import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { patchEnv } from "../../../../tests/helpers/env.js";
import {
  cliDebugOptions,
  debug,
  debugLogPath,
  diagDump,
  errorMessage,
} from "../log.js";

let dir: string;

let restoreEnv: () => void;

const readLog = (file: string) => readFileSync(file, "utf-8");

describe("the debug log", () => {
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "claude-bridge-log-"));
    restoreEnv = patchEnv({
      CLAUDE_BRIDGE_DEBUG: undefined,
      CLAUDE_BRIDGE_DEBUG_PATH: undefined,
    });
  });

  afterEach(() => {
    restoreEnv();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("debugLogPath", () => {
    it("defaults to the extension's data directory under pi's agent dir", () => {
      expect(debugLogPath()).toBe(
        path.join(getAgentDir(), "data", "claude-bridge", "logs", "debug.log")
      );
    });

    // Resolved per call: an import-time constant would keep returning the first value.
    it("follows environment changes made after import", () => {
      const agentDir = path.join(dir, "agent");
      const restore = patchEnv({ PI_CODING_AGENT_DIR: agentDir });

      try {
        expect(debugLogPath()).toBe(
          path.join(agentDir, "data", "claude-bridge", "logs", "debug.log")
        );

        patchEnv({ CLAUDE_BRIDGE_DEBUG_PATH: path.join(dir, "override.log") });

        expect(debugLogPath()).toBe(path.join(dir, "override.log"));

        patchEnv({ CLAUDE_BRIDGE_DEBUG_PATH: "" });

        expect(debugLogPath()).toBe(
          path.join(agentDir, "data", "claude-bridge", "logs", "debug.log")
        );
      } finally {
        restore();
      }
    });
  });

  describe("debug", () => {
    // The log carries prompts and conversation text.
    it("writes nothing unless CLAUDE_BRIDGE_DEBUG=1", () => {
      const logFile = path.join(dir, "debug.log");

      patchEnv({
        CLAUDE_BRIDGE_DEBUG_PATH: logFile,
        CLAUDE_BRIDGE_DEBUG: "true",
      });
      debug("secret prompt");
      diagDump("never", { a: 1 });

      expect(existsSync(logFile)).toBe(false);
    });

    it("appends to the debug log when enabled", () => {
      const logFile = path.join(dir, "nested", "debug.log");

      patchEnv({ CLAUDE_BRIDGE_DEBUG_PATH: logFile, CLAUDE_BRIDGE_DEBUG: "1" });
      debug("first", { n: 1 });
      diagDump("orphan", { id: "toolu_1", pending: 2 });

      const lines = readLog(logFile).trimEnd().split("\n");

      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/ first \{"n":1\}$/u);
      expect(lines[1]).toMatch(/ DIAG orphan \{"id":"toolu_1","pending":2\}$/u);
    });
  });

  describe("cliDebugOptions", () => {
    it("adds nothing when debugging is off", () => {
      expect(cliDebugOptions("provider")).toStrictEqual({});
    });

    it("puts Claude Code's debug log beside the bridge's and traces its stderr", () => {
      const logFile = path.join(dir, "debug.log");

      patchEnv({ CLAUDE_BRIDGE_DEBUG_PATH: logFile, CLAUDE_BRIDGE_DEBUG: "1" });

      const options = cliDebugOptions("provider");

      expect(options.debug).toBe(true);
      expect(path.dirname(options.debugFile ?? "")).toBe(
        path.join(dir, "cc-cli")
      );
      expect(path.basename(options.debugFile ?? "")).toMatch(
        /-provider-\d+\.log$/u
      );
      expect(existsSync(path.join(dir, "cc-cli"))).toBe(true);

      options.stderr?.("warning one\r\n\nwarning two\n");

      const log = readLog(logFile);

      expect(log).toMatch(/\[cli-stderr provider#\d+\] warning one\n/u);
      expect(log).toMatch(/\[cli-stderr provider#\d+\] warning two\n/u);
      expect(log).not.toMatch(/\[cli-stderr provider#\d+\] \n/u);
    });
  });

  describe("errorMessage", () => {
    it("reads the message from errors and error-shaped values", () => {
      expect(errorMessage(new Error("boom"))).toBe("boom");
      expect(errorMessage({ message: "from message" })).toBe("from message");
      expect(errorMessage({ error: "from error" })).toBe("from error");
      expect(errorMessage("plain")).toBe("plain");
      expect(errorMessage({ code: 1 })).toBe('{"code":1}');
    });
  });
});
