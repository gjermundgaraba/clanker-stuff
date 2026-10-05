/** Presentation only. Stored calls and results from retired tool shapes fall back to sanitized text. */
import { preview } from "@clanker-stuff/pi-tool-rendering/preview";
import { displayText as clean, inlineText } from "@clanker-stuff/pi-tool-rendering/text";
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

// Open display contracts tolerate new wire fields without interpreting them.
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
  }),
);

const ResultDisplaySchema = Type.Partial(
  Type.Object({
    agents: Type.Array(Type.Object({ agent_name: Type.String(), agent_status: StatusSchema })),
    message: Type.String(),
    previous_status: StatusSchema,
    task_name: Type.String(),
    timed_out: Type.Boolean(),
  }),
);

const ExecutionSettingsSchema = Type.Object({
  model: Type.Optional(Type.String()),
  thinkingLevel: Type.Optional(Type.String()),
});

type AgentStatus = Static<typeof StatusSchema>;

type Renderers = Required<Pick<ToolDefinition, "renderCall" | "renderResult">>;

const inline = (value: string | undefined) => inlineText(value ?? "");

const status = (value: AgentStatus, theme: Theme): string => {
  if (typeof value !== "string") {
    return "completed" in value
      ? theme.fg("success", "✓ completed")
      : theme.fg("error", "✗ errored");
  }

  const label = inline(value).replaceAll("_", " ");

  if (value === "running") return theme.fg("accent", `● ${label}`);

  if (value === "not_found") return theme.fg("error", `✗ ${label}`);

  return theme.fg("muted", `■ ${label}`);
};

export const agentRenderers = (name: string): Renderers => ({
  renderCall(args, theme, context) {
    const data = Value.Check(CallDisplaySchema, args) ? args : {};

    return preview(
      () => {
        const target = data.task_name ?? data.target ?? data.path_prefix;

        const lines = [
          `${theme.fg("toolTitle", theme.bold(name))}${target ? ` ${theme.fg("accent", inline(target))}` : ""}`,
        ];

        const settings = [
          data.agent_type ? `role ${inline(data.agent_type)}` : "",
          inline(data.model),
          inline(data.reasoning_effort),
        ].filter(Boolean);

        if (settings.length > 0) lines.push(theme.fg("muted", settings.join(" · ")));

        if (context.expanded && data.fork_turns !== undefined)
          lines.push(theme.fg("muted", `history: ${inline(data.fork_turns)}`));

        if (context.expanded && data.timeout_ms !== undefined)
          lines.push(theme.fg("muted", `timeout: ${data.timeout_ms / 1000}s`));

        if (data.message) lines.push(theme.fg("toolOutput", clean(data.message)));

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

    const raw = () => {
      add(() => theme.fg("toolOutput", clean(text)));

      return output;
    };

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
      return raw();
    }

    if (!Value.Check(ResultDisplaySchema, parsed)) {
      return raw();
    }

    const data = parsed;

    const addStatus = (value: AgentStatus, target: string, prefix = "") => {
      add(
        () =>
          `${prefix ? theme.fg("muted", prefix) : ""}${target ? `${theme.fg("accent", inline(target))} · ` : ""}${status(value, theme)}`,
      );

      if (typeof value === "string") return;

      const detail = "completed" in value ? clean(value.completed ?? "") : clean(value.errored);

      if (detail) add(() => theme.fg("errored" in value ? "error" : "toolOutput", detail));
    };

    if (name === "spawn_agent" && data.task_name !== undefined) {
      const task = data.task_name;
      add(() => `${theme.fg("success", "✓ Spawned")} ${theme.fg("accent", inline(task))}`);
      const execution = Value.Check(ExecutionSettingsSchema, result.details) ? result.details : {};

      const settings = [
        execution.model ? `model ${inline(execution.model)}` : "",
        execution.thinkingLevel ? `thinking ${inline(execution.thinkingLevel)}` : "",
      ].filter(Boolean);

      if (settings.length > 0) add(() => theme.fg("muted", settings.join(" · ")));
    } else if (data.previous_status !== undefined) {
      // The previous status is not the target's current state.
      addStatus(data.previous_status, "", "Previous status · ");
    } else if (name === "wait_agent" && data.timed_out !== undefined) {
      add(() =>
        theme.fg(
          data.timed_out === true ? "muted" : "success",
          data.timed_out === true ? "Wait timed out" : "✓ Activity received",
        ),
      );

      if (data.message !== undefined) add(() => theme.fg("toolOutput", clean(data.message ?? "")));
    } else if (data.agents !== undefined) {
      const agents = data.agents;
      add(() => theme.fg("muted", `${agents.length} agents`));

      if (options.expanded) {
        for (const agent of agents) addStatus(agent.agent_status, agent.agent_name);
      } else {
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
    } else {
      return raw();
    }

    return output;
  },
});
