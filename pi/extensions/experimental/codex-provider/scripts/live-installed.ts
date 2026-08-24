#!/usr/bin/env node
import { deepStrictEqual, ok as assert } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { getAgentDir, RpcClient } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

import { auditLocalOrder } from "../audit-local-order.ts";
import { resolveCheckpointCarrier } from "../checkpoint.ts";
import { isWireRecord as isRecord, StringValueSchema } from "./wire.ts";
import type { WireRecord, WireValue } from "./wire.ts";

const SUPPORTED_PI_VERSION = "0.84.2";
const configuredModel = process.env.CODEX_COMPACTION_LIVE_MODEL?.trim();
const LIVE_MODEL =
  configuredModel !== undefined && configuredModel.length > 0 ? configuredModel : "gpt-5.6-sol";

const resolveInstalledPiCli = () => {
  const systemPath = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((entry) => !entry.endsWith(`${path.sep}node_modules${path.sep}.bin`))
    .join(path.delimiter);
  const executable = execFileSync("which", ["pi"], {
    encoding: "utf-8",
    env: { ...process.env, PATH: systemPath },
  }).trim();
  assert(executable.length > 0, "System pi was not found on PATH");
  const cliPath = realpathSync(executable);
  assert(
    path.basename(cliPath) === "cli.js" && path.basename(path.dirname(cliPath)) === "dist",
    `System pi does not resolve to a compiled dist/cli.js: ${cliPath}`,
  );
  const version = execFileSync(process.execPath, [cliPath, "--version"], {
    encoding: "utf-8",
  }).trim();
  assert(
    version === SUPPORTED_PI_VERSION,
    `Unsupported installed Pi version ${version}; expected ${SUPPORTED_PI_VERSION}`,
  );
  return cliPath;
};

const eventType = (event: WireValue) =>
  isRecord(event) && Value.Check(StringValueSchema, event.type) ? event.type : undefined;

const waitForNotify = (client: RpcClient, messagePrefix: string, timeoutMs = 10_000) => {
  const result = Promise.withResolvers<WireRecord>();
  const unsubscribe = client.onEvent((event) => {
    const candidate: WireValue = event;
    if (
      isRecord(candidate) &&
      candidate.type === "extension_ui_request" &&
      candidate.method === "notify" &&
      Value.Check(StringValueSchema, candidate.message) &&
      candidate.message.startsWith(messagePrefix)
    ) {
      result.resolve(candidate);
    }
  });
  const timeout = setTimeout(() => {
    result.reject(new Error(`Timed out waiting for ${messagePrefix}`));
  }, timeoutMs);
  return result.promise.finally(() => {
    clearTimeout(timeout);
    unsubscribe();
  });
};

const toolNames = (events: readonly JsonAgentSessionEvent[]) =>
  events.flatMap((event) => (event.type === "tool_execution_start" ? [event.toolName] : []));

const isLiveModel = (
  model: { readonly api: string; readonly id: string; readonly provider: string } | undefined,
) =>
  model?.provider === "openai-codex" &&
  model.api === "openai-codex-responses" &&
  model.id === LIVE_MODEL;

const requireCommands = (commands: Awaited<ReturnType<RpcClient["getCommands"]>>) => {
  for (const name of ["code-mode", "codex-provider", "tools"]) {
    assert(
      commands.some((command) => command.name === name),
      `Installed /${name} command is unavailable`,
    );
  }
};

const clientOptions = ({
  agentDir,
  cliPath,
  cwd,
  sessionDir,
  sessionFile,
}: {
  readonly agentDir: string;
  readonly cliPath: string;
  readonly cwd: string;
  readonly sessionDir: string;
  readonly sessionFile?: string;
}) =>
  new RpcClient({
    args: [
      "--session-dir",
      sessionDir,
      ...(sessionFile === undefined ? [] : ["--session", sessionFile]),
      "--approve",
      "--offline",
      "--thinking",
      "minimal",
    ],
    cliPath,
    cwd,
    env: { PI_CODING_AGENT_DIR: agentDir },
    model: LIVE_MODEL,
    provider: "openai-codex",
  });

const run = async () => {
  const cliPath = resolveInstalledPiCli();
  const agentDir = getAgentDir();
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-provider-installed-"));
  const cwd = path.join(root, "workspace");
  const projectSettingsDir = path.join(cwd, ".pi");
  const sessionDir = path.join(root, "sessions");
  const sentinel = `installed-${randomBytes(8).toString("hex")}`;
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(projectSettingsDir, { recursive: true }),
    mkdir(sessionDir, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      path.join(cwd, "AGENTS.md"),
      "# Canary project\n\nThe environment code is REAL-INSTALLED-PI.\n",
    ),
    writeFile(
      path.join(projectSettingsDir, "settings.json"),
      `${JSON.stringify({ compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1000 } })}\n`,
    ),
    writeFile(path.join(cwd, "source.txt"), `${sentinel}\n`),
  ]);

  console.log(`Live installed artifacts: ${root}`);
  const audit = await auditLocalOrder({
    agentDir,
    cwd,
    piVersion: SUPPORTED_PI_VERSION,
  });

  const extensionErrors: unknown[] = [];
  let client = clientOptions({ agentDir, cliPath, cwd, sessionDir });
  const watchErrors = (event: JsonAgentSessionEvent) => {
    if (eventType(event) === "extension_error") {
      extensionErrors.push(event);
    }
  };
  let unsubscribe = client.onEvent(watchErrors);
  try {
    await client.start();
    const initialState = await client.getState();
    assert(initialState.model, "Installed Pi did not select a model");
    assert(
      isLiveModel(initialState.model),
      `Installed Pi selected ${initialState.model.provider}/${initialState.model.id} with API ${initialState.model.api}`,
    );
    const availableModels = await client.getAvailableModels();
    const declaredModel = availableModels.find(
      ({ id, provider }) =>
        id === initialState.model?.id && provider === initialState.model.provider,
    );
    assert(
      initialState.model.contextWindow > 4096 &&
        initialState.model.contextWindow === declaredModel?.contextWindow,
      "Installed canary is not using the model's native declared context window",
    );
    requireCommands(await client.getCommands());

    await client.promptAndWait(
      "Create a unique recall token in the exact format OPAQUE- followed by 12 uppercase hexadecimal characters. Reply only with that token.",
      undefined,
      180_000,
    );
    const generatedToken = await client.getLastAssistantText();
    const recallToken = generatedToken?.trim();
    assert(
      recallToken !== undefined &&
        recallToken.length > 0 &&
        /^OPAQUE-[0-9A-F]{12}$/u.test(recallToken),
      "Initial turn did not generate an opaque recall token",
    );

    const initialEvents = await client.promptAndWait(
      "Remember the opaque token from the previous turn without repeating it. Call exec_command exactly once to run `cat source.txt`. Then call apply_patch exactly once to create result.txt whose only line is the command output. Do not call any other tool. Reply exactly INITIAL_OK followed by the environment code from the project instructions.",
      undefined,
      180_000,
    );
    const initialTools = toolNames(initialEvents);
    deepStrictEqual(
      initialTools,
      ["exec_command", "apply_patch"],
      "Initial turn did not use only the direct Codex tools",
    );
    const copied = await readFile(path.join(cwd, "result.txt"), "utf-8");
    assert(copied.trim() === sentinel, "Initial turn did not copy the sentinel safely");
    const initialText = await client.getLastAssistantText();
    assert(
      Value.Check(StringValueSchema, initialText) &&
        initialText.includes("INITIAL_OK") &&
        initialText.includes("REAL-INSTALLED-PI") &&
        !initialText.includes(recallToken),
      "Initial turn did not load the project context",
    );

    const codeModeEnabled = waitForNotify(client, "Code Mode enabled");
    await client.prompt("/code-mode");
    await codeModeEnabled;
    const codeModeEvents = await client.promptAndWait(
      `Call exec exactly once and do not call any other top-level tool. In that JavaScript call, first await tools.exec_command with command "true" and ignore its result, then await tools.apply_patch to create code-mode.txt whose only line is exactly ${sentinel}. Reply exactly CODE_MODE_OK.`,
      undefined,
      180_000,
    );
    deepStrictEqual(toolNames(codeModeEvents), ["exec"], "Code Mode turn did not use only exec");
    const codeModeCopy = await readFile(path.join(cwd, "code-mode.txt"), "utf-8");
    assert(
      codeModeCopy.trim() === sentinel,
      "Code Mode nested tools did not copy the sentinel safely",
    );

    await client.compact(
      "Omit the assistant-generated opaque recall token from the readable history summary.",
    );
    const compacted = await client.getEntries();
    const compactions = compacted.entries.filter((entry) => entry.type === "compaction");
    assert(compactions.length === 1, "Expected exactly one manual compaction");
    const carrier = resolveCheckpointCarrier(compactions[0]);
    assert(
      carrier.kind === "checkpoint" &&
        carrier.checkpoint.version === 1 &&
        carrier.checkpoint.reason === "manual",
      "Manual compaction did not persist a strict schema-v1 checkpoint",
    );
    const compactionIndex = compacted.entries.indexOf(compactions[0]);
    const firstKeptIndex = compacted.entries.findIndex(
      ({ id }) => id === compactions[0].firstKeptEntryId,
    );
    assert(
      firstKeptIndex !== -1 &&
        firstKeptIndex < compactionIndex &&
        !JSON.stringify({
          retained: compacted.entries.slice(firstKeptIndex, compactionIndex),
          summary: compactions[0].summary,
        }).includes(recallToken),
      "Compacted session retained the opaque recall token in plaintext",
    );

    const beforeStatus = await client.getEntries();
    const notified = waitForNotify(client, "Codex provider status\n");
    await client.prompt("/codex-provider");
    await notified;
    const afterStatus = await client.getEntries();
    deepStrictEqual(afterStatus, beforeStatus, "/codex-provider changed persisted session state");

    const state = await client.getState();
    assert(
      Value.Check(StringValueSchema, state.sessionFile) && state.sessionFile.length > 0,
      "Installed canary did not create a session file",
    );
    assert(
      !path.relative(sessionDir, state.sessionFile).startsWith(".."),
      `Installed canary escaped its session directory: ${state.sessionFile}`,
    );

    unsubscribe();
    await client.stop();
    await Promise.all([
      rm(path.join(cwd, "code-mode.txt")),
      rm(path.join(cwd, "source.txt")),
      rm(path.join(cwd, "result.txt")),
    ]);
    client = clientOptions({
      agentDir,
      cliPath,
      cwd,
      sessionDir,
      sessionFile: state.sessionFile,
    });
    unsubscribe = client.onEvent(watchErrors);
    await client.start();
    const reopenedState = await client.getState();
    assert(
      isLiveModel(reopenedState.model) &&
        reopenedState.model?.contextWindow === initialState.model.contextWindow,
      "Fresh Pi process did not restore the requested native model",
    );
    const reopened = await client.getEntries();
    deepStrictEqual(
      reopened,
      afterStatus,
      "Fresh process did not reopen the exact checkpoint branch",
    );
    const resumeEvents = await client.promptAndWait(
      "Without reading any file, call apply_patch exactly once to create resumed.txt containing only the assistant-generated opaque token from before compaction. Do not call another tool. Then reply exactly RESUME_OK.",
      undefined,
      180_000,
    );
    const resumeTools = toolNames(resumeEvents);
    deepStrictEqual(
      resumeTools,
      ["apply_patch"],
      "Resume did not use only the direct apply_patch tool",
    );
    const resumed = await readFile(path.join(cwd, "resumed.txt"), "utf-8");
    assert(
      resumed.trim() === recallToken,
      "Fresh-process checkpoint replay did not restore the opaque token",
    );
    const resumeText = await client.getLastAssistantText();
    assert(
      Value.Check(StringValueSchema, resumeText) && resumeText.includes("RESUME_OK"),
      "Fresh-process resume did not finish cleanly",
    );
    assert(extensionErrors.length === 0, "An installed extension emitted extension_error");

    console.log(
      JSON.stringify(
        {
          configuredExtensions: audit.count,
          contextWindow: initialState.model.contextWindow,
          model: `openai-codex/${LIVE_MODEL}`,
          sessionFile: state.sessionFile,
          status: "passed",
        },
        null,
        2,
      ),
    );
  } finally {
    unsubscribe();
    await client.stop();
  }
};

if (import.meta.main) {
  if (process.argv.includes("--help")) {
    console.log(`Usage: vp run test:live:installed

Runs a paid happy-path canary through the system-installed Pi 0.84.2, actual
configured environment, native model context window, and isolated temp project.`);
  } else {
    try {
      await run();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
