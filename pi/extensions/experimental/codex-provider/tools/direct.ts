/* oxlint-disable eslint/sort-keys -- preserve native harness field order */
import { createLazySingleton } from "@clanker-stuff/lazy-singleton";
import type {
  AgentToolResult,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createReadToolDefinition,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { resolvePath } from "./path.js";
import type { ProcessManager, ProcessResult } from "./process.js";

const strict = { additionalProperties: false } as const;

export const CODEX_MODEL_IDS = new Set([
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

export const isCodexToolsModel = (model: ExtensionContext["model"]) =>
  model?.provider === "openai-codex" &&
  model.api === "openai-codex-responses" &&
  CODEX_MODEL_IDS.has(model.id) &&
  model.compat !== undefined &&
  "supportsOpenAIGrammarTools" in model.compat &&
  model.compat.supportsOpenAIGrammarTools === true;

const textResult = (text: string, details: unknown = {}) => ({
  content: [{ text, type: "text" as const }],
  details,
});

const processResult = ({
  output,
  ...details
}: ProcessResult): AgentToolResult<unknown> => textResult(output, details);

export const createCodexDirectTools = () => {
  const processes = createLazySingleton<ProcessManager>(async (signal) => {
    const { ProcessManager } = await import("./process.js");
    signal.throwIfAborted();
    return new ProcessManager();
  });
  const processManager = async (): Promise<ProcessManager> => {
    const manager = await processes.load();
    if (manager === undefined) {
      throw new Error("Process manager is disposed");
    }
    return manager;
  };
  const definitions = [
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
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const manager = await processManager();
        return processResult(
          await manager.start({
            command: params.cmd,
            ctx,
            cwd:
              params.workdir === undefined
                ? ctx.cwd
                : resolvePath(params.workdir, ctx.cwd),
            signal,
            yieldMs: params.yield_time_ms ?? 10_000,
          })
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
      async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
        const manager = await processManager();
        return processResult(
          await manager.continue({
            chars: params.chars,
            sessionId: params.session_id,
            signal,
            yieldMs: params.yield_time_ms ?? 1000,
          })
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
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const { applyPatch } = await import("./patch.js");
        const result = await applyPatch(params.patch, ctx.cwd, signal);
        return textResult(result.output, {
          changes: result.changes,
        });
      },
    }),
    defineTool({
      name: "view_image",
      label: "View Image",
      description: "Attach a local image to the conversation.",
      parameters: Type.Object({ path: Type.String() }, strict),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        return await createReadToolDefinition(ctx.cwd).execute(
          toolCallId,
          { path: params.path },
          signal,
          onUpdate,
          ctx
        );
      },
    }),
  ];
  return {
    definitions,
    dispose: () => processes.stop((manager) => manager.dispose()),
  };
};
