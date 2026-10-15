// Shared setup for the live suites: a real AgentSession on a claude-bridge model, served
// by the user's own Claude Code login through the Agent SDK. Every query bills the user's
// Claude subscription, so the suites run only with CLAUDE_BRIDGE_LIVE=1.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { getProjectDir } from "cc-session-io";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { expect } from "vite-plus/test";

import {
  createAgentSessionHarness,
  type AgentSessionHarness,
  type AgentSessionHarnessOptions,
} from "../../../../tests/harness/agent-session.js";
import { patchEnv } from "../../../../tests/helpers/env.js";
import claudeBridge from "../index.js";

export const LIVE = process.env.CLAUDE_BRIDGE_LIVE === "1";

export const LIVE_MODEL = process.env.CLAUDE_BRIDGE_LIVE_MODEL ?? "claude-haiku-5-5";

/** Real Claude Code round trips: process start, API latency, and tool waits. */
export const LIVE_TIMEOUT = 240_000;

/** The bridge's debug log, read in slices so each test asserts only on what it caused. */
export interface DebugLog {
  readonly path: string;
  mark(): number;
  since(mark: number): string;
}

/**
 * Point the Claude Code child at the user's real login and turn on the bridge's debug
 * log. Call from beforeAll; the returned restore undoes it.
 *
 * The test setup patches HOME to a temp dir, and the child inherits process.env, so
 * Claude Code would find no login. HOME goes back to the real one rather than setting
 * CLAUDE_CONFIG_DIR: on macOS the login lives in the keychain, and Claude Code derives
 * the keychain entry's name from CLAUDE_CONFIG_DIR when it is set, so pointing it at the
 * default directory explicitly can still miss the login. A CLAUDE_CONFIG_DIR the user
 * already exports is inherited unchanged. pi itself stays isolated: the setup's
 * PI_CODING_AGENT_DIR and the harness's agentDir do not depend on HOME.
 *
 * Consequence: the session files the bridge and Claude Code write land under the real
 * ~/.claude/projects (or $CLAUDE_CONFIG_DIR/projects), in a directory named after the
 * session's temp cwd. LiveSession.close() deletes that directory.
 */
export function liveEnvironment(): { log: DebugLog; restore: () => void } {
  const realHome = os.userInfo().homedir;
  const logDir = mkdtempSync(path.join(os.tmpdir(), "claude-bridge-live-"));
  const logPath = path.join(logDir, "debug.log");

  const restoreEnv = patchEnv({
    HOME: realHome,
    USERPROFILE: realHome,
    CLAUDE_BRIDGE_DEBUG: "1",
    CLAUDE_BRIDGE_DEBUG_PATH: logPath,
  });

  const log: DebugLog = {
    path: logPath,
    mark: () => (existsSync(logPath) ? statSync(logPath).size : 0),
    since: (mark) => (existsSync(logPath) ? readFileSync(logPath, "utf8").slice(mark) : ""),
  };

  return {
    log,
    restore: () => {
      restoreEnv();
      rmSync(logDir, { force: true, recursive: true });
    },
  };
}

export interface LiveSession {
  readonly h: AgentSessionHarness;
  /** Claude Code's project directory for this session's cwd. */
  readonly projectDir: string;
  /** Prompt and wait for the agent to settle; returns the final assistant text. */
  ask(text: string): Promise<string>;
  /** Switch to the claude-bridge model under test. */
  useBridge(): Promise<void>;
  /** Switch to the harness's faux model: "another provider" without credentials. */
  useFaux(): Promise<void>;
  close(): Promise<void>;
}

export async function createLiveSession(
  options: Pick<AgentSessionHarnessOptions, "settings" | "systemPrompt" | "tools"> = {},
): Promise<LiveSession> {
  const h = await createAgentSessionHarness({
    ...options,
    extensionFactories: [claudeBridge],
  });

  // Resolved now: the hash follows the realpath, which is gone once cleanup removes it.
  const projectDir = getProjectDir(h.tempDir);
  const fauxModel = h.session.model;
  const bridgeModel = h.session.modelRuntime.getModel("claude-bridge", LIVE_MODEL);

  if (bridgeModel === undefined || fauxModel === undefined) {
    h.cleanup();
    throw new Error(`claude-bridge/${LIVE_MODEL} is not registered`);
  }

  await h.session.setModel(bridgeModel);

  return {
    h,
    projectDir,
    async ask(text) {
      await h.prompt(text);

      return expectAnswer(h);
    },
    useBridge: () => h.session.setModel(bridgeModel),
    useFaux: () => h.session.setModel(fauxModel),
    async close() {
      try {
        await h.session.abort();
        await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      } finally {
        h.cleanup();
        rmSync(projectDir, { force: true, recursive: true });
      }
    },
  };
}

/** The final assistant message's text, asserting the run ended in an answer, not an error. */
export function expectAnswer(h: AgentSessionHarness): string {
  const message = h.messages().findLast((m) => m.role === "assistant");

  expect(message?.role).toBe("assistant");

  if (message?.role !== "assistant") return "";

  expect(message.stopReason, message.errorMessage).not.toBe("error");

  return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

/** Resolves on the session's next event that `matches`. */
export function nextEvent(
  h: AgentSessionHarness,
  matches: (event: AgentSessionEvent) => boolean,
): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = h.session.subscribe((event) => {
      if (!matches(event)) return;

      unsubscribe();
      resolve();
    });
  });
}

/** One `sync:` line: what a provider call did with the session's conversation. */
export interface SyncLine {
  kind: "deliver" | "side" | "resume" | "rebuild";
  reason: string | undefined;
}

const SYNC_KINDS = ["deliver", "side", "resume", "rebuild"] as const;

export function syncLines(log: string): SyncLine[] {
  return [...log.matchAll(/sync: (\w+)(?: reason=(\w+))?/g)].flatMap((match) => {
    const kind = SYNC_KINDS.find((candidate) => candidate === match[1]);

    return kind === undefined ? [] : [{ kind, reason: match[2] }];
  });
}

/** The session each query ran in, as Claude Code reported it, in order. */
export const sessionIds = (log: string): string[] =>
  [...log.matchAll(/conversation: session ([0-9a-f-]+)/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );

const SessionRecordSchema = Type.Object({
  type: Type.Optional(Type.String()),
  attachment: Type.Optional(
    Type.Object({ type: Type.Optional(Type.String()), prompt: Type.Optional(Type.Unknown()) }),
  ),
  message: Type.Optional(Type.Object({ content: Type.Optional(Type.Unknown()) })),
});

export type SessionRecord = Static<typeof SessionRecordSchema>;

/** Claude Code's own transcript of the last query in a debug-log slice, in write order. */
export function sessionRecords(log: string, projectDir: string): SessionRecord[] {
  const sessionId = sessionIds(log).at(-1);

  expect(sessionId, "no query reported a session in the debug log").toBeDefined();

  const file = path.join(projectDir, `${sessionId ?? ""}.jsonl`);

  expect(existsSync(file), `no session file ${file}`).toBe(true);

  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => Value.Parse(SessionRecordSchema, JSON.parse(line)));
}

/** Whether `word` reached Claude Code's session, as message content or an attachment. */
export const sessionMentions = (records: readonly SessionRecord[], word: string): boolean =>
  records.some(
    (r) =>
      JSON.stringify(r.attachment ?? "").includes(word) ||
      JSON.stringify(r.message?.content ?? "").includes(word),
  );
