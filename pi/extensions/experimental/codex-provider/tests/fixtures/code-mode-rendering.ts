import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

import { createIdentityTheme } from "../../../../../tests/harness/tui.js";
import { CodeModeRuntime } from "../../code-mode/tools.js";
import type { RuntimeToolTrace } from "../../code-mode/types.js";
import { createCodexDirectTools } from "../../tools/direct.js";
import { formatProcessMetadata } from "../../tools/process-metadata.js";
import { stripVTControlCharacters } from "node:util";

export type Context = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];

export const context = (expanded = false): Context => ({
  args: {},
  argsComplete: true,
  cwd: "/tmp/demo",
  executionStarted: true,
  expanded,
  invalidate() {},
  isError: false,
  isPartial: false,
  lastComponent: undefined,
  showImages: false,
  state: {},
  toolCallId: "synthetic",
});

export const theme = createIdentityTheme();

// Content rows only: the shell's blank padding rows and one-column side padding are dropped.
// Content never starts or ends with a blank row.
export const rows = (component: Component, width = 80): string[] => {
  const lines = component
    .render(width)
    .map((line) => stripVTControlCharacters(line).trimEnd().replace(/^ /u, ""));

  while (lines[0] === "") lines.shift();

  while (lines.at(-1) === "") lines.pop();

  return lines;
};

export const codeModeTool = (
  name = "exec",
  definitions: ToolDefinition[] = createCodexDirectTools().nestedDefinitions,
) => {
  const runtime = new CodeModeRuntime();
  runtime.prepareNestedTools(definitions.map((definition) => ({ definition })))();
  const tool = runtime.createTools().find((tool) => tool.name === name);

  if (!tool?.renderCall || !tool.renderResult) throw new Error("Missing Code Mode renderer");

  return { definition: tool, renderCall: tool.renderCall, renderResult: tool.renderResult };
};

export const processTrace = (
  id: string,
  cmd: string,
  output: string,
  exitCode = 0,
): RuntimeToolTrace => {
  const details = {
    durationMs: 1200,
    exitCode,
    status: "exited" as const,
    codeModeResult: {
      output,
      exit_code: exitCode,
      wall_time_seconds: 1.2,
      original_token_count: 30,
    },
  };

  return {
    id,
    input: { cmd },
    name: "exec_command",
    status: "done",
    result: {
      content: [{ type: "text", text: `${output}\n\n${formatProcessMetadata(details)}` }],
      details,
    },
  };
};

export const result = (traces: RuntimeToolTrace[], output: string[] = [], status = "result") => ({
  content: [
    { type: "text" as const, text: "Script completed" },
    ...output.map((text) => ({ type: "text" as const, text })),
  ],
  details: { cellId: "demo", codeMode: true, status, traces },
});
