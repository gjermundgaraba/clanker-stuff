/* oxlint-disable eslint/sort-keys -- preserve native harness field order */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { HarnessProfile } from "./types.js";

const strict = { additionalProperties: false } as const;
const CODEX_MODEL_IDS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]);

const APPLY_PATCH_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?
hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF (change_move change? | change)
filename: /(.+)/
add_line: "+" /(.*)/ LF -> line
change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF
%import common.LF`;

const supportsGrammarTools = (
  model: Parameters<HarnessProfile["matches"]>[0]
) => {
  const { compat } = model;
  return (
    typeof compat === "object" &&
    compat !== null &&
    "supportsOpenAIGrammarTools" in compat &&
    compat.supportsOpenAIGrammarTools === true
  );
};

export const codexProfile: HarnessProfile = {
  createTools: (core) => [
    defineTool({
      name: "exec_command",
      label: "Execute Command",
      description:
        "Runs a shell command. Long-running commands return a session ID for write_stdin.",
      parameters: Type.Object(
        {
          cmd: Type.String(),
          workdir: Type.Optional(Type.String()),
          yield_time_ms: Type.Optional(Type.Integer({ minimum: 0 })),
        },
        strict
      ),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        return await core.runProcess(
          {
            command: params.cmd,
            workdir: params.workdir,
            yieldMs: params.yield_time_ms,
          },
          { ctx, onUpdate, signal, toolCallId }
        );
      },
    }),
    defineTool({
      name: "write_stdin",
      label: "Write Stdin",
      description: "Writes to or polls a running exec_command session.",
      parameters: Type.Object(
        {
          session_id: Type.Integer({ minimum: 1 }),
          chars: Type.Optional(Type.String()),
          yield_time_ms: Type.Optional(Type.Integer({ minimum: 0 })),
        },
        strict
      ),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        return await core.continueProcess(
          {
            chars: params.chars,
            sessionId: params.session_id,
            yieldMs: params.yield_time_ms,
          },
          { ctx, onUpdate, signal, toolCallId }
        );
      },
    }),
    defineTool({
      name: "apply_patch",
      label: "Apply Patch",
      description:
        "Apply a patch to files. Provide the patch directly, from *** Begin Patch through *** End Patch; do not wrap it in JSON.",
      parameters: Type.Object(
        { patch: Type.String({ description: "The complete patch text" }) },
        strict
      ),
      constrainedSampling: {
        type: "grammar",
        variants: { openai_lark: APPLY_PATCH_GRAMMAR },
      },
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        return await core.patch(params.patch, {
          ctx,
          onUpdate,
          signal,
          toolCallId,
        });
      },
    }),
    defineTool({
      name: "view_image",
      label: "View Image",
      description: "Attach a local image to the conversation.",
      parameters: Type.Object({ path: Type.String() }, strict),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        return await core.read(
          { path: params.path },
          { ctx, onUpdate, signal, toolCallId }
        );
      },
    }),
  ],
  id: "codex",
  matches: (model) =>
    CODEX_MODEL_IDS.has(model.id) && supportsGrammarTools(model),
};
