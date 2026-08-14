/* oxlint-disable eslint/sort-keys -- preserve native harness field order */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { prepareForegroundArguments } from "./arguments.js";
import type { HarnessProfile } from "./types.js";

const strict = { additionalProperties: false } as const;

export const grokBuildProfile: HarnessProfile = {
  createTools: (operations) => [
    defineTool({
      name: "run_terminal_cmd",
      label: "Run Terminal Command",
      description: "Run a terminal command in the current workspace.",
      parameters: Type.Object(
        {
          command: Type.String(),
          description: Type.String(),
          timeout: Type.Optional(Type.Integer({ minimum: 1 })),
        },
        strict
      ),
      prepareArguments: prepareForegroundArguments,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        return await operations.runShell(
          {
            command: params.command,
            timeoutMs: params.timeout,
          },
          { ctx, onUpdate, signal, toolCallId }
        );
      },
    }),
    defineTool({
      name: "read_file",
      label: "Read File",
      description: "Read a text or model-readable media file.",
      parameters: Type.Object(
        {
          target_file: Type.String(),
          offset: Type.Optional(Type.Integer({ minimum: 0 })),
          limit: Type.Optional(Type.Integer({ minimum: 1 })),
        },
        strict
      ),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        return await operations.read(
          {
            limit: params.limit,
            offset: params.offset === undefined ? undefined : params.offset + 1,
            path: params.target_file,
          },
          { ctx, onUpdate, signal, toolCallId }
        );
      },
    }),
    defineTool({
      name: "search_replace",
      label: "Search Replace",
      description: "Replace exact text in a file.",
      parameters: Type.Object(
        {
          file_path: Type.String(),
          old_string: Type.String(),
          new_string: Type.String(),
          replace_all: Type.Optional(Type.Boolean()),
        },
        strict
      ),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        return await operations.replace(
          {
            newText: params.new_string,
            oldText: params.old_string,
            path: params.file_path,
            replaceAll: params.replace_all,
          },
          { ctx, onUpdate, signal, toolCallId }
        );
      },
    }),
    defineTool({
      name: "grep",
      label: "Grep",
      description: "Search file contents using a regular expression.",
      parameters: Type.Object(
        {
          pattern: Type.String(),
          path: Type.Optional(Type.String()),
          glob: Type.Optional(Type.String()),
          "-A": Type.Optional(Type.Integer({ minimum: 0 })),
          "-B": Type.Optional(Type.Integer({ minimum: 0 })),
          "-C": Type.Optional(Type.Integer({ minimum: 0 })),
          "-i": Type.Optional(Type.Boolean()),
          head_limit: Type.Optional(Type.Integer({ minimum: 1 })),
          multiline: Type.Optional(Type.Boolean()),
        },
        strict
      ),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        return await operations.grep(
          {
            afterContext: params["-A"],
            beforeContext: params["-B"],
            context: params["-C"],
            glob: params.glob,
            ignoreCase: params["-i"],
            limit: params.head_limit,
            multiline: params.multiline,
            path: params.path,
            pattern: params.pattern,
          },
          { ctx, onUpdate, signal, toolCallId }
        );
      },
    }),
    defineTool({
      name: "list_dir",
      label: "List Directory",
      description: "List entries in a directory.",
      parameters: Type.Object({ target_directory: Type.String() }, strict),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        return await operations.list(
          { path: params.target_directory },
          { ctx, onUpdate, signal, toolCallId }
        );
      },
    }),
  ],
  matches: (model) => model.id === "grok-4.5",
};
