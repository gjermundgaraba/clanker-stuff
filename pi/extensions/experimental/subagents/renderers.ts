import { preview } from "@clanker-stuff/pi-tool-rendering/preview";
import {
  displayText as clean,
  inlineText,
} from "@clanker-stuff/pi-tool-rendering/text";
import { contentText } from "@earendil-works/pi-ai";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type {
  MessageRenderer,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import { isAgentPath, MailDetailsSchema, readEnvelope } from "./protocol.js";
import {
  agentName,
  isDisplayStatus,
  statusGlyph,
  statusTone,
  treeRows,
} from "./ui/format.js";
import type { DisplayStatus } from "./ui/format.js";

const StatusSchema = Type.Union([
  Type.String(),
  Type.Object({ completed: Type.Union([Type.String(), Type.Null()]) }),
  Type.Object({ errored: Type.String() }),
]);

const CallDisplaySchema = Type.Partial(
  Type.Object({
    agent_type: Type.String(),
    fork_turns: Type.String(),
    message: Type.String(),
    model: Type.String(),
    path_prefix: Type.String(),
    reasoning_effort: Type.String(),
    target: Type.String(),
    task_name: Type.String(),
    timeout_ms: Type.Number(),
  })
);

const ResultDisplaySchema = Type.Partial(
  Type.Object({
    agents: Type.Array(
      Type.Object({ agent_name: Type.String(), agent_status: StatusSchema })
    ),
    message: Type.String(),
    previous_status: StatusSchema,
    task_name: Type.String(),
    timed_out: Type.Boolean(),
  })
);

const ExecutionSettingsSchema = Type.Object({
  model: Type.Optional(Type.String()),
  thinkingLevel: Type.Optional(Type.String()),
});

type AgentStatus = Static<typeof StatusSchema>;

type Renderers = Required<Pick<ToolDefinition, "renderCall" | "renderResult">>;

const inline = (value: string | undefined) => inlineText(value ?? "");

const displayStatus = (value: AgentStatus): DisplayStatus => {
  if (typeof value !== "string") {
    return "completed" in value ? "completed" : "errored";
  }

  return isDisplayStatus(value) ? value : "interrupted";
};

const status = (value: AgentStatus, theme: Theme): string => {
  const shown = displayStatus(value);

  const label =
    typeof value === "string" ? inline(value).replaceAll("_", " ") : shown;

  return `${statusGlyph(theme, shown)} ${theme.fg(statusTone(shown), label)}`;
};

const statusDetail = (value: AgentStatus): string => {
  if (typeof value === "string") {
    return "";
  }

  return "completed" in value ? (value.completed ?? "") : value.errored;
};

const continuation = (prefix: string): string =>
  prefix.replace(/[├└]─ $/u, (end) => (end.startsWith("├") ? "│  " : "   "));

const listing = (
  theme: Theme,
  agents: ReadonlyArray<{ agent_status: AgentStatus; path: string }>,
  expanded: boolean
): string[] =>
  treeRows(agents).flatMap((row) => {
    const prefix = theme.fg("dim", row.prefix);
    const name = inline(agentName(row.path));

    if (row.item === undefined) {
      return [`${prefix}${theme.fg("muted", name)}`];
    }

    const head = `${prefix}${theme.fg("accent", name)} ${status(row.item.agent_status, theme)}`;
    const detail = clean(statusDetail(row.item.agent_status));

    if (!expanded || detail === "") {
      return [head];
    }

    const tone =
      statusTone(displayStatus(row.item.agent_status)) === "error"
        ? "error"
        : "toolOutput";

    const indent = theme.fg("dim", `${continuation(row.prefix)}  `);

    return [
      head,
      ...detail.split("\n").map((line) => `${indent}${theme.fg(tone, line)}`),
    ];
  });

/** How the collaboration tools draw, in transcripts too. */
export const agentRenderers = (name: string): Renderers => ({
  renderCall(args, theme, context) {
    const data = Value.Check(CallDisplaySchema, args) ? args : {};

    return preview(
      () => {
        const target = data.task_name ?? data.target ?? data.path_prefix;

        const lines = [
          `${theme.fg("toolTitle", theme.bold(name))}${target !== undefined && target !== "" ? ` ${theme.fg("accent", inline(target))}` : ""}`,
        ];

        const settings = [
          data.agent_type !== undefined && data.agent_type !== ""
            ? `role ${inline(data.agent_type)}`
            : "",
          inline(data.model),
          inline(data.reasoning_effort),
        ].filter(Boolean);

        if (settings.length > 0) {
          lines.push(theme.fg("muted", settings.join(" · ")));
        }

        if (context.expanded && data.fork_turns !== undefined) {
          lines.push(theme.fg("muted", `history: ${inline(data.fork_turns)}`));
        }

        if (context.expanded && data.timeout_ms !== undefined) {
          lines.push(theme.fg("muted", `timeout: ${data.timeout_ms / 1000}s`));
        }

        if (data.message !== undefined && data.message !== "") {
          lines.push(theme.fg("toolOutput", clean(data.message)));
        }

        if (context.isPartial) {
          lines.push(
            theme.fg("accent", context.executionStarted ? "● working" : "…")
          );
        }

        return new Text(lines.join("\n"), 0, 0);
      },
      context.expanded,
      3
    );
  },
  renderResult(result, options, theme, context) {
    const text = contentText(result.content);

    const output = new Container();

    const add = (draw: () => string, limit = 5) => {
      output.addChild(
        preview(() => new Text(draw(), 0, 0), options.expanded, limit)
      );
    };

    const raw = () => {
      add(() => theme.fg("toolOutput", clean(text)));

      return output;
    };

    if (context.isError || options.isPartial) {
      add(() =>
        theme.fg(
          context.isError ? "error" : "accent",
          clean(text) || "● working"
        )
      );

      return output;
    }

    const args = Value.Check(CallDisplaySchema, context.args)
      ? context.args
      : {};

    const target =
      args.target === undefined
        ? ""
        : ` ${theme.fg("text", inline(args.target))}`;

    if (!text && (name === "send_message" || name === "followup_task")) {
      add(
        () =>
          `${theme.fg("success", name === "send_message" ? "✓ Message queued" : "✓ Follow-up submitted")}${target}`
      );

      return output;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(text);
    } catch {
      return raw();
    }

    if (!Value.Check(ResultDisplaySchema, parsed)) {
      return raw();
    }

    const data = parsed;

    if (name === "spawn_agent" && data.task_name !== undefined) {
      const task = data.task_name;
      add(
        () =>
          `${theme.fg("success", "✓ Spawned")} ${theme.fg("accent", inline(task))}`
      );

      const execution = Value.Check(ExecutionSettingsSchema, result.details)
        ? result.details
        : {};

      const settings = [
        execution.model !== undefined && execution.model !== ""
          ? `model ${inline(execution.model)}`
          : "",
        execution.thinkingLevel !== undefined && execution.thinkingLevel !== ""
          ? `thinking ${inline(execution.thinkingLevel)}`
          : "",
      ].filter(Boolean);

      if (settings.length > 0) {
        add(() => theme.fg("muted", settings.join(" · ")));
      }
    } else if (data.previous_status !== undefined) {
      const previous = data.previous_status;

      add(() =>
        [
          previous === "running"
            ? `${theme.fg("muted", "■ Interrupted")}${target}`
            : `${theme.fg("muted", "Nothing to interrupt")}${target}`,
          theme.fg("dim", " · "),
          theme.fg("muted", "was "),
          status(previous, theme),
        ].join("")
      );
    } else if (name === "wait_agent" && data.timed_out !== undefined) {
      add(() =>
        data.timed_out === true
          ? theme.fg("muted", "◷ Wait timed out")
          : theme.fg("success", "✓ Activity received")
      );

      if (data.message !== undefined) {
        add(() => theme.fg("muted", clean(data.message ?? "")));
      }
    } else if (data.agents === undefined) {
      return raw();
    } else {
      const agents = data.agents.map((agent) => ({
        ...agent,
        path: agent.agent_name,
      }));

      if (!agents.every((agent) => isAgentPath(agent.path))) {
        return raw();
      }

      add(() => {
        const running = agents.filter(
          (agent) => agent.agent_status === "running"
        ).length;

        return `${theme.fg("muted", `${agents.length} agents`)}${
          running > 0
            ? `${theme.fg("dim", " · ")}${theme.fg("accent", `${running} running`)}`
            : ""
        }`;
      });

      if (agents.length > 0) {
        add(() => listing(theme, agents, options.expanded).join("\n"), 8);
      }
    }

    return output;
  },
});

const PREVIEW_ROWS = { FINAL_ANSWER: 6, MESSAGE: 2, NEW_TASK: 6 } as const;

/**
 * Mail as a card: a final answer naming its sender and outcome, a task steered into a running turn,
 * or a quieter note for a message. The model receives the envelope text either way.
 */
export const mailRenderer: MessageRenderer = (message, options, theme) => {
  const text = contentText(message.content);

  const envelope = readEnvelope(text);

  if (envelope === undefined) {
    return new Text(theme.fg("toolOutput", clean(text)), options.outputPad, 0);
  }

  const sender = theme.bold(inline(agentName(envelope.from)));
  let heading: string;

  if (envelope.kind === "NEW_TASK") {
    heading = `${theme.fg("muted", "▸ task from")} ${sender}`;
  } else if (envelope.kind === "MESSAGE") {
    heading = `${theme.fg("muted", "✉ message from")} ${sender}`;
  } else if (
    Value.Check(MailDetailsSchema, message.details) &&
    message.details.failed === true
  ) {
    heading = `${theme.fg("error", "✗")} ${sender} ${theme.fg("error", "failed")}`;
  } else {
    heading = `${theme.fg("success", "✓")} ${sender} ${theme.fg("muted", "finished")}`;
  }

  const box = new Box(options.outputPad, 0);
  box.addChild(
    new Text(
      `${heading}${theme.fg("dim", " · ")}${theme.fg("muted", inline(envelope.from))}`,
      0,
      0
    )
  );
  const body = clean(envelope.content).trim();

  if (body !== "") {
    box.addChild(
      preview(
        () => new Markdown(body, 2, 0, getMarkdownTheme()),
        options.expanded,
        PREVIEW_ROWS[envelope.kind]
      )
    );
  }

  return box;
};
