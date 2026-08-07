/* oxlint-disable eslint/sort-keys -- preserve native harness field order */
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { HarnessProfile } from "./types.js";

const strict = { additionalProperties: false } as const;

export const kimiCodeProfile: HarnessProfile = {
  createTools: (operations) => [
    defineTool({
      name: "Read",
      label: "Read",
      description: "Read text from a file with optional line pagination.",
      parameters: Type.Object(
        {
          path: Type.String(),
          line_offset: Type.Optional(Type.Integer({ minimum: 1 })),
          n_lines: Type.Optional(Type.Integer({ maximum: 1000, minimum: 1 })),
        },
        strict
      ),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        return await operations.read(
          {
            limit: params.n_lines,
            offset: params.line_offset,
            path: params.path,
          },
          { ctx, onUpdate, signal, toolCallId }
        );
      },
    }),
    defineTool({
      name: "ReadMediaFile",
      label: "Read Media File",
      description: "Read an image or other model-supported media file.",
      parameters: Type.Object({ path: Type.String() }, strict),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        return await operations.read(
          { path: params.path },
          { ctx, onUpdate, signal, toolCallId }
        );
      },
    }),
    defineTool({
      name: "Write",
      label: "Write",
      description: "Write or append text to a file.",
      parameters: Type.Object(
        {
          path: Type.String(),
          content: Type.String(),
          mode: Type.Optional(StringEnum(["overwrite", "append"] as const)),
        },
        strict
      ),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        return await operations.write(
          {
            content: params.content,
            mode: params.mode,
            path: params.path,
          },
          { ctx, onUpdate, signal, toolCallId }
        );
      },
    }),
    defineTool({
      name: "Edit",
      label: "Edit",
      description: "Replace exact text in a file.",
      parameters: Type.Object(
        {
          path: Type.String(),
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
            path: params.path,
            replaceAll: params.replace_all,
          },
          { ctx, onUpdate, signal, toolCallId }
        );
      },
    }),
    defineTool({
      name: "Grep",
      label: "Grep",
      description: "Search file contents using a regular expression.",
      parameters: Type.Object(
        {
          pattern: Type.String(),
          path: Type.Optional(Type.String()),
          glob: Type.Optional(Type.String()),
          output_mode: Type.Optional(
            StringEnum(["content", "files_with_matches", "count"] as const)
          ),
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
      name: "Glob",
      label: "Glob",
      description: "Find files matching a glob pattern.",
      parameters: Type.Object(
        {
          path: Type.Optional(Type.String()),
          pattern: Type.String(),
        },
        strict
      ),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        return await operations.findFiles(
          {
            limit: 100,
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
      description: "Execute a shell command in the foreground or background.",
      parameters: Type.Object(
        {
          command: Type.String(),
          cwd: Type.Optional(Type.String()),
          timeout: Type.Optional(Type.Integer({ minimum: 1 })),
          run_in_background: Type.Optional(Type.Boolean()),
          description: Type.Optional(Type.String()),
          disable_timeout: Type.Optional(Type.Boolean()),
        },
        strict
      ),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        return await operations.runShell(
          {
            background: params.run_in_background,
            command: params.command,
            cwd: params.cwd,
            timeoutMs:
              params.disable_timeout === true ? undefined : params.timeout,
          },
          { ctx, onUpdate, signal, toolCallId }
        );
      },
    }),
  ],
  id: "kimi-code",
  matches: (model) => model.id === "kimi-k3",
};
