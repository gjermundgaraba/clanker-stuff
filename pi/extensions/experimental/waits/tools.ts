import { inlineText } from "@clanker-stuff/pi-tool-rendering/text";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { callLine, rowsResult } from "./render.js";
import { rowText } from "./report.js";
import type { ToolDetails, WaitRow } from "./report.js";
import type { WaitRuntime } from "./runtime.js";
import { startParameters } from "./spec.js";

const reply = (text: string, rows: readonly WaitRow[]) => ({
  content: [{ type: "text" as const, text }],
  details: { rows: [...rows] } satisfies ToolDetails,
});

export const listText = (rows: readonly WaitRow[]): string =>
  rows.length
    ? rows.map((row) => rowText(row)).join("\n")
    : "No live waits in this session.";

export const registerWaitTools = (
  pi: ExtensionAPI,
  runtime: WaitRuntime
): void => {
  pi.registerTool({
    name: "wait_start",
    label: "Start wait",
    description:
      "Wait for a shell condition without blocking. It is checked now and then on an interval; when it exits 0, or the wait expires first, you are woken once. Survives /reload, /tree, quitting and relaunching this session, and a killed Pi; /new, fork and clone do not inherit it.",
    promptSnippet:
      "Wait on a shell condition that survives restarts, and be woken once when it holds",
    promptGuidelines: [
      "After wait_start, end your turn or keep doing other work; do not poll or sleep to wait. You are woken automatically, even in a restarted session.",
      "Write conditions that fail closed and prove freshness: exit 0 only on evidence that this run finished (a result ID you have not used, a marker unique to this run), never on missing input or a previous run's output.",
      "Put everything a later session needs into instruction: what to do with the result, and how to tell a new result from one already used.",
    ],
    parameters: startParameters,
    execute: async (_id, params, _signal, _update, ctx) => {
      const row = runtime.open(params, ctx);

      return reply(
        `Started ${rowText(row)}. End your turn; you will be woken once it is satisfied or expires.`,
        [row]
      );
    },
    renderCall: (args, theme) => callLine(theme, "wait_start", args.label),
    renderResult: (result, options, theme, context) =>
      rowsResult(theme, result, options, context.isError),
  });
  pi.registerTool({
    name: "wait_list",
    label: "List waits",
    description:
      "List this session's live waits: each one's state, last check result, label and ID.",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => {
      const rows = runtime.rows();

      return reply(listText(rows), rows);
    },
    renderCall: (_args, theme) => callLine(theme, "wait_list", undefined),
    renderResult: (result, options, theme, context) =>
      rowsResult(theme, result, options, context.isError),
  });
  pi.registerTool({
    name: "wait_cancel",
    label: "Cancel wait",
    description: "Cancel a live wait so it never wakes you.",
    parameters: Type.Object(
      { id: Type.String({ minLength: 1 }) },
      { additionalProperties: false }
    ),
    execute: async (_id, params) => {
      const row = runtime.cancel(params.id);

      return reply(
        `Cancelled ${inlineText(row.label)} (${row.id}); it will not wake you.`,
        [row]
      );
    },
    renderCall: (args, theme) => callLine(theme, "wait_cancel", args.id),
    renderResult: (result, options, theme, context) =>
      rowsResult(theme, result, options, context.isError),
  });
};
