/** Presentation only. V1/V2 wire results and persisted controller state remain untouched. */
import { preview } from "@clanker-stuff/pi-tool-rendering/preview";
import { displayText as clean, inlineText } from "@clanker-stuff/pi-tool-rendering/text";
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";

import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

// Open display contracts tolerate new wire fields without interpreting them.
const StatusDetailSchema = Type.Object({
  completed: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  errored: Type.Optional(Type.String()),
});

const StatusSchema = Type.Union([Type.String(), StatusDetailSchema]);

const StatusMapSchema = Type.Record(Type.String(), StatusSchema);

const CallDisplaySchema = Type.Partial(
  Type.Object({
    task_name: Type.String(),
    target: Type.String(),
    id: Type.String(),
    path_prefix: Type.String(),
    targets: Type.Array(Type.String()),
    agent_type: Type.String(),
    model: Type.String(),
    reasoning_effort: Type.String(),
    interrupt: Type.Boolean(),
    fork_turns: Type.String(),
    fork_context: Type.Boolean(),
    timeout_ms: Type.Number(),
    message: Type.String(),
    items: Type.Array(
      Type.Object({
        type: Type.String(),
        text: Type.Optional(Type.String()),
        name: Type.Optional(Type.String()),
        path: Type.Optional(Type.String()),
      }),
    ),
  }),
);

const ResultDisplaySchema = Type.Partial(
  Type.Object({
    agent_id: Type.String(),
    task_name: Type.String(),
    nickname: Type.String(),
    submission_id: Type.String(),
    previous_status: StatusSchema,
    status: Type.Union([StatusSchema, StatusMapSchema]),
    timed_out: Type.Boolean(),
    message: Type.String(),
    agents: Type.Array(Type.Object({ agent_name: Type.String(), agent_status: StatusSchema })),
  }),
);

const NicknameSchema = Type.Object({ nickname: Type.Optional(Type.String()) });

type AgentStatus = Static<typeof StatusSchema>;

type CallDisplay = Static<typeof CallDisplaySchema>;

type Renderers = Required<Pick<ToolDefinition, "renderCall" | "renderResult">>;

const str = (value: string | null | undefined) => clean(value ?? "");

const inline = (value: string | undefined) => inlineText(value ?? "");

const status = (value: AgentStatus, theme: Theme): string => {
  if (typeof value !== "string") {
    if (value.completed !== undefined) return theme.fg("success", "✓ completed");

    if (value.errored !== undefined) return theme.fg("error", "✗ errored");

    return theme.fg("muted", "unknown status");
  }

  const label = inline(value).replaceAll("_", " ");

  if (value === "running" || value === "pending_init") return theme.fg("accent", `● ${label}`);

  if (value === "not_found") return theme.fg("error", `✗ ${label}`);

  return theme.fg("muted", `■ ${label}`);
};

const inputText = (args: CallDisplay): string => {
  if (args.message !== undefined) return str(args.message);

  if (args.items === undefined) return "";

  return args.items
    .map((item) => {
      if (item.type === "text") return str(item.text);

      if (item.type === "skill") return `[skill: ${inline(item.name)}]`;

      if (item.type === "local_image") return `[image: ${inline(item.path)}]`;

      // Never dump base64 image data into a transcript header.
      return `[${inline(item.type) || "input item"}]`;
    })
    .join("\n");
};

export const agentRenderers = (name: string): Renderers => ({
  renderCall(args, theme, context) {
    const data = Value.Check(CallDisplaySchema, args) ? args : {};

    return preview(
      () => {
        const target = data.task_name ?? data.target ?? data.id ?? data.path_prefix;
        const targets = data.targets?.map(inline).join(", ") ?? "";
        const heading = `${theme.fg("toolTitle", theme.bold(name))}${target || targets ? ` ${theme.fg("accent", inline(target) || targets)}` : ""}`;
        const lines = [heading];

        const settings = [
          data.agent_type ? `role ${inline(data.agent_type)}` : "",
          data.model ? inline(data.model) : "",
          data.reasoning_effort ? inline(data.reasoning_effort) : "",
          data.interrupt === true ? "interrupt" : "",
        ].filter(Boolean);

        if (settings.length) lines.push(theme.fg("muted", settings.join(" · ")));

        if (context.expanded) {
          if (data.fork_turns !== undefined)
            lines.push(theme.fg("muted", `history: ${inline(data.fork_turns)}`));

          if (data.fork_context !== undefined)
            lines.push(theme.fg("muted", `fork context: ${data.fork_context}`));

          if (data.timeout_ms !== undefined)
            lines.push(theme.fg("muted", `timeout: ${data.timeout_ms / 1000}s`));
        }

        const message = inputText(data);

        if (message) lines.push(theme.fg("toolOutput", message));

        if (context.isPartial)
          lines.push(theme.fg("accent", context.executionStarted ? "● working" : "…"));

        return new Text(lines.join("\n"), 0, 0);
      },
      context.expanded,
      3,
    );
  },
  renderResult(result, options, theme, context) {
    const text = result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");

    const output = new Container();

    const add = (draw: () => string, limit = 5) =>
      output.addChild(preview(() => new Text(draw(), 0, 0), options.expanded, limit));

    if (context.isError || options.isPartial) {
      add(() => theme.fg(context.isError ? "error" : "accent", clean(text) || "● working"));

      return output;
    }

    if (!text && (name === "send_message" || name === "followup_task")) {
      add(() =>
        theme.fg("success", name === "send_message" ? "✓ Message queued" : "✓ Follow-up submitted"),
      );

      return output;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(text);
    } catch {
      add(() => theme.fg("toolOutput", clean(text)));

      return output;
    }

    if (!Value.Check(ResultDisplaySchema, parsed)) {
      add(() => theme.fg("toolOutput", clean(text)));

      return output;
    }

    if (
      name === "wait_agent" &&
      parsed.status !== undefined &&
      !Value.Check(StatusMapSchema, parsed.status)
    ) {
      add(() => theme.fg("toolOutput", clean(text)));

      return output;
    }

    const data = parsed;

    const addStatus = (value: AgentStatus, target = "", prefix = "") => {
      add(
        () =>
          `${prefix ? theme.fg("muted", prefix) : ""}${target ? `${theme.fg("accent", inline(target))} · ` : ""}${status(value, theme)}`,
      );

      if (typeof value === "string") return;

      const answer = str(value.errored) || str(value.completed);

      if (answer) add(() => theme.fg(value.errored ? "error" : "toolOutput", answer));
    };

    if (name === "spawn_agent" && (data.agent_id !== undefined || data.task_name !== undefined)) {
      const details = Value.Check(NicknameSchema, result.details) ? result.details : {};
      const nickname = inline(data.nickname) || inline(details.nickname);
      add(
        () =>
          `${theme.fg("success", "✓ Spawned")} ${theme.fg("accent", inline(data.task_name) || inline(data.agent_id))}${nickname ? theme.fg("muted", ` · ${nickname}`) : ""}`,
      );
    } else if (data.submission_id !== undefined) {
      add(
        () =>
          `${theme.fg("success", "✓ Input submitted")} ${theme.fg("muted", inline(data.submission_id))}`,
      );
    } else if (data.previous_status !== undefined) {
      // Do not imply the previous status is the target's current state or claim a missing target was stopped.
      addStatus(data.previous_status, "", "Previous status · ");
    } else if (name === "resume_agent" && Value.Check(StatusSchema, data.status)) {
      addStatus(data.status);
    } else if (name === "wait_agent" && data.timed_out !== undefined) {
      add(() =>
        theme.fg(
          data.timed_out ? "muted" : "success",
          data.timed_out ? "Wait timed out" : "✓ Activity received",
        ),
      );

      if (data.message !== undefined) add(() => theme.fg("toolOutput", str(data.message)));

      if (Value.Check(StatusMapSchema, data.status)) {
        for (const [target, value] of Object.entries(data.status)) addStatus(value, target);
      }
    } else if (data.agents !== undefined) {
      const agents = data.agents;
      add(() => theme.fg("muted", `${agents.length} resident agents`));

      if (options.expanded) {
        for (const agent of agents) addStatus(agent.agent_status, str(agent.agent_name));
      } else {
        // Bound the whole summary list; expanded rows include each agent's details exactly once.
        add(
          () =>
            agents
              .map(
                (agent) =>
                  `${theme.fg("accent", inline(agent.agent_name))} · ${status(agent.agent_status, theme)}`,
              )
              .join("\n"),
          8,
        );
      }
    } else add(() => theme.fg("toolOutput", clean(text)));

    return output;
  },
});
