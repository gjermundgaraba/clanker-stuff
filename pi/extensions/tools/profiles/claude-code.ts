/* oxlint-disable eslint/sort-keys -- preserve native harness field order */
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { prepareForegroundArguments } from "./arguments.js";
import type { HarnessProfile } from "./types.js";

const strict = { additionalProperties: false } as const;
const CLAUDE_CODE_MODEL_IDS = new Set([
  "claude-sonnet-5",
  "claude-opus-5",
  "claude-fable-5",
  "glm-5.2",
  "glm-5p2",
  "accounts/fireworks/models/glm-5p2",
  "accounts/fireworks/routers/glm-5p2-fast",
  "zai-org/GLM-5.2",
]);

export const claudeCodeProfile: HarnessProfile = {
  createTools: (operations) => [
    defineTool({
      name: "Read",
      label: "Read",
      description:
        "Reads a file from the local filesystem. Use offset and limit for long files.",
      parameters: Type.Object(
        {
          file_path: Type.String({
            description: "The absolute path to the file",
          }),
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
            path: params.file_path,
          },
          { ctx, onUpdate, signal, toolCallId }
        );
      },
    }),
    defineTool({
      name: "Write",
      label: "Write",
      description: "Writes a file to the local filesystem.",
      parameters: Type.Object(
        {
          file_path: Type.String({
            description: "The absolute path to the file",
          }),
          content: Type.String({ description: "The content to write" }),
        },
        strict
      ),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        return await operations.write(
          { content: params.content, path: params.file_path },
          { ctx, onUpdate, signal, toolCallId }
        );
      },
    }),
    defineTool({
      name: "Edit",
      label: "Edit",
      description:
        "Performs exact string replacements in a file. old_string must be unique unless replace_all is true.",
      parameters: Type.Object(
        {
          file_path: Type.String({
            description: "The absolute path to the file",
          }),
          old_string: Type.String(),
          new_string: Type.String(),
          replace_all: Type.Optional(Type.Boolean({ default: false })),
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
      name: "Glob",
      label: "Glob",
      description: "Finds files matching a glob pattern.",
      parameters: Type.Object(
        {
          pattern: Type.String(),
          path: Type.Optional(Type.String()),
        },
        strict
      ),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        return await operations.findFiles(
          { path: params.path, pattern: params.pattern },
          { ctx, onUpdate, signal, toolCallId }
        );
      },
    }),
    defineTool({
      name: "Grep",
      label: "Grep",
      description: "Searches file contents using regular expressions.",
      parameters: Type.Object(
        {
          pattern: Type.String(),
          path: Type.Optional(Type.String()),
          glob: Type.Optional(Type.String()),
          output_mode: Type.Optional(
            StringEnum(["content", "files_with_matches", "count"] as const)
          ),
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
            outputMode: params.output_mode,
            path: params.path,
            pattern: params.pattern,
          },
          { ctx, onUpdate, signal, toolCallId }
        );
      },
    }),
    defineTool({
      name: "Bash",
      label: "Bash",
      description: "Executes a shell command and returns its output.",
      parameters: Type.Object(
        {
          command: Type.String(),
          description: Type.Optional(Type.String()),
          timeout: Type.Optional(
            Type.Integer({ maximum: 600_000, minimum: 1 })
          ),
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
  ],
  matches: (model) => CLAUDE_CODE_MODEL_IDS.has(model.id),
};
