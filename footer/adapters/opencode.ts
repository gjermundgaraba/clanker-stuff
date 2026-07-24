import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import type { UsageFetchResult, UsageWindow, UsageWindowId } from "../types.js";
import { usageFailure, usageResult } from "../types.js";
import { isDefined, makeUsageWindow, parseIso } from "./util.js";

// oxlint-disable-next-line typescript/strict-void-return -- Node promisify typing
const execFileAsync = promisify(execFile);

export interface CodexBarExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CodexBarExec = (
  binary: string,
  args: string[],
  timeoutMs: number
) => Promise<CodexBarExecResult>;

export type CodexBarDiscover = (
  env?: NodeJS.ProcessEnv,
  defaultCandidates?: readonly string[]
) => Promise<string | undefined>;

const CODEXBAR_TIMEOUT_MS = 30_000;
const CODEXBAR_MISSING_MESSAGE =
  "CodexBar CLI not found (install CodexBar CLI or symlink codexbar onto PATH)";

const DEFAULT_CANDIDATES = [
  "/opt/homebrew/bin/codexbar",
  "/usr/local/bin/codexbar",
  "/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI",
];

const isExecutable = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const pathCandidates = (env: NodeJS.ProcessEnv): string[] => {
  const pathValue = env.PATH ?? env.Path ?? "";
  return pathValue
    .split(path.delimiter)
    .filter((entry) => entry.length > 0)
    .map((dir) => path.join(dir, "codexbar"));
};

export const discoverCodexBarBinary: CodexBarDiscover = async (
  env = process.env,
  defaultCandidates = DEFAULT_CANDIDATES
) => {
  const fromEnv = env.CODEXBAR_BIN;
  if (
    typeof fromEnv === "string" &&
    fromEnv.length > 0 &&
    (await isExecutable(fromEnv))
  ) {
    return fromEnv;
  }

  const candidates = [...pathCandidates(env), ...defaultCandidates];
  const executable = await Promise.all(candidates.map(isExecutable));
  return candidates[executable.indexOf(true)];
};

const ExecFileErrorSchema = Type.Object({
  code: Type.Optional(Type.Union([Type.Number(), Type.String()])),
  killed: Type.Optional(Type.Boolean()),
  message: Type.Optional(Type.String()),
  stderr: Type.Optional(Type.String()),
  stdout: Type.Optional(Type.String()),
});

export const defaultCodexBarExec: CodexBarExec = async (
  binary,
  args,
  timeoutMs
) => {
  try {
    const { stdout, stderr } = await execFileAsync(binary, args, {
      maxBuffer: 2 * 1024 * 1024,
      timeout: timeoutMs,
    });
    return {
      code: 0,
      stderr: typeof stderr === "string" ? stderr : "",
      stdout: typeof stdout === "string" ? stdout : "",
    };
  } catch (error) {
    if (!Value.Check(ExecFileErrorSchema, error)) {
      return { code: 1, stderr: "CodexBar CLI failed", stdout: "" };
    }
    if (error.killed === true) {
      return {
        code: 124,
        stderr: error.stderr ?? "",
        stdout: error.stdout ?? "",
      };
    }
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stderr: error.stderr ?? error.message ?? "",
      stdout: error.stdout ?? "",
    };
  }
};

const WINDOW_MAP: {
  key: "primary" | "secondary" | "tertiary";
  id: UsageWindowId;
}[] = [
  { id: "5h", key: "primary" },
  { id: "7d", key: "secondary" },
  { id: "month", key: "tertiary" },
];

const CodexBarWindowSchema = Type.Object({
  resetsAt: Type.Optional(Type.String()),
  usedPercent: Type.Number(),
});

const NullableCodexBarWindowSchema = Type.Union([
  CodexBarWindowSchema,
  Type.Null(),
]);

const CodexBarEntrySchema = Type.Object({
  error: Type.Optional(Type.String()),
  ok: Type.Optional(Type.Boolean()),
  plan: Type.Optional(Type.String()),
  provider: Type.String(),
  usage: Type.Optional(
    Type.Object({
      primary: Type.Optional(NullableCodexBarWindowSchema),
      secondary: Type.Optional(NullableCodexBarWindowSchema),
      tertiary: Type.Optional(NullableCodexBarWindowSchema),
    })
  ),
});

const CodexBarOutputSchema = Type.Array(CodexBarEntrySchema);

const mapUsageWindow = (
  window: Static<typeof CodexBarWindowSchema> | null | undefined,
  id: UsageWindowId
): UsageWindow | undefined => {
  if (window === null || window === undefined) {
    return undefined;
  }
  return makeUsageWindow(
    id,
    100 - window.usedPercent,
    parseIso(window.resetsAt)
  );
};

export const parseCodexBarUsageJson = (
  stdout: string,
  providerId: string,
  nowMs: number = Date.now()
): UsageFetchResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return usageFailure("invalid CodexBar JSON");
  }

  if (!Value.Check(CodexBarOutputSchema, parsed)) {
    return usageFailure("invalid CodexBar JSON");
  }

  const match = parsed.find((entry) => entry.provider === providerId);
  if (match === undefined) {
    return usageFailure(`no CodexBar usage for provider ${providerId}`);
  }

  if (match.ok === false) {
    const message =
      typeof match.error === "string" && match.error.length > 0
        ? match.error
        : "CodexBar reported an error";
    return usageFailure(message);
  }

  const { usage } = match;
  const windows =
    usage === undefined
      ? []
      : WINDOW_MAP.map(({ key, id }) => mapUsageWindow(usage[key], id)).filter(
          isDefined
        );

  const planLabel = match.plan;
  return usageResult({
    fetchedAt: nowMs,
    provider: "opencode-go",
    windows,
    ...(planLabel === undefined ? {} : { planLabel }),
  });
};

export interface RunCodexBarUsageOptions {
  discover?: CodexBarDiscover;
  exec?: CodexBarExec;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  now?: () => number;
}

const OPENCODE_GO_CODEXBAR_PROVIDER = "opencodego";

export const runCodexBarUsage = async (
  options: RunCodexBarUsageOptions = {}
): Promise<UsageFetchResult> => {
  const now = options.now ?? Date.now;
  const discover = options.discover ?? discoverCodexBarBinary;
  const exec = options.exec ?? defaultCodexBarExec;
  const timeoutMs = options.timeoutMs ?? CODEXBAR_TIMEOUT_MS;

  const binary = await discover(options.env ?? process.env);
  if (binary === undefined || binary.length === 0) {
    return usageFailure(CODEXBAR_MISSING_MESSAGE, "unavailable");
  }

  const args = [
    "usage",
    "--provider",
    OPENCODE_GO_CODEXBAR_PROVIDER,
    "--format",
    "json",
    "--json-only",
  ];
  const result = await exec(binary, args, timeoutMs);

  if (result.code === 0) {
    return parseCodexBarUsageJson(
      result.stdout,
      OPENCODE_GO_CODEXBAR_PROVIDER,
      now()
    );
  }

  if (result.code === 124) {
    return usageFailure("CodexBar CLI timed out");
  }
  const detail = (result.stderr || result.stdout).trim();
  if (detail.length > 0) {
    return usageFailure(`CodexBar CLI failed: ${detail.slice(0, 160)}`);
  }
  return usageFailure("CodexBar CLI failed");
};
