import { displayText } from "@clanker-stuff/pi-tool-rendering/text";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { runQueuedPrompt } from "@clanker-stuff/pi-user-input/queue";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ElicitResult, PrimitiveSchemaDefinition } from "@modelcontextprotocol/client";
import type { ElicitationParams } from "./elicitation-schema.js";
import { openBrowser } from "./open-browser.js";

type Value = string | number | boolean | string[];

const choices = (
  field: PrimitiveSchemaDefinition,
): { value: string; label: string }[] | undefined => {
  if (field.type === "array") {
    return "enum" in field.items
      ? field.items.enum.map((value) => ({ value, label: value }))
      : field.items.anyOf.map((item) => ({ value: item.const, label: item.title ?? item.const }));
  }
  if ("oneOf" in field)
    return field.oneOf.map((item) => ({ value: item.const, label: item.title ?? item.const }));
  if ("enum" in field)
    return field.enum.map((value, index) => ({
      value,
      label: "enumNames" in field ? (field.enumNames?.[index] ?? value) : value,
    }));
  return undefined;
};

export const elicit = async (
  ctx: ExtensionContext,
  server: string,
  params: ElicitationParams,
  signal: AbortSignal,
  completion?: AbortSignal,
): Promise<ElicitResult> => {
  if (!ctx.hasUI) return { action: "cancel" };
  return await runQueuedPrompt(ctx, signal, async (signal) => {
    const title = displayText(`MCP ${server}: ${params.message}`);
    if (params.mode === "url") {
      const destination = new URL(params.url);
      if (!["https:", "http:"].includes(destination.protocol))
        throw new Error("MCP interaction URL must use HTTP or HTTPS");
      const action = await ctx.ui.select(
        `${title}\n${displayText(destination.href)}`,
        ["Open URL", "Decline", "Cancel"],
        { signal },
      );
      if (action === "Decline") return { action: "decline" };
      if (action !== "Open URL") return { action: "cancel" };
      if (ctx.mode === "tui") openBrowser(destination.href);
      else
        ctx.ui.notify(
          displayText(`Open ${destination.href} to complete the request from ${server}`),
          "info",
        );
      let completed: string | undefined;
      try {
        const waitSignal = completion ? AbortSignal.any([signal, completion]) : signal;
        waitSignal.throwIfAborted();
        completed = await ctx.ui.select(
          `${title}\nComplete the interaction at ${displayText(destination.href)}, then continue.`,
          ["Completed", "Decline", "Cancel"],
          { signal: waitSignal },
        );
      } catch (error) {
        signal.throwIfAborted();
        if (!completion?.aborted) throw error;
        completed = "Completed";
      }
      signal.throwIfAborted();
      if (completion?.aborted) completed = "Completed";
      return {
        action:
          completed === "Completed" ? "accept" : completed === "Decline" ? "decline" : "cancel",
      };
    }
    const action = await ctx.ui.select(title, ["Fill form", "Decline", "Cancel"], { signal });
    if (action !== "Fill form") return { action: action === "Decline" ? "decline" : "cancel" };
    const validator = new AjvJsonSchemaValidator();
    const content: Record<string, Value> = Object.create(null);
    for (const [name, field] of Object.entries(params.requestedSchema.properties)) {
      const label = displayText(
        `${title}\n${field.title ?? name}${field.description ? ` — ${field.description}` : ""}`,
      );
      if (!params.requestedSchema.required?.includes(name)) {
        const include = await ctx.ui.select(label, ["Provide value", "Skip field", "Cancel"], {
          signal,
        });
        if (include === "Skip field") continue;
        if (include !== "Provide value") return { action: "cancel" };
      }
      const options = choices(field);
      if (field.type === "array" && options) {
        const selected: string[] = [];
        for (;;) {
          const labels = options.map(
            (item, i) =>
              `${selected.includes(item.value) ? "✓ " : ""}${i + 1}. ${displayText(item.label)}`,
          );
          const answer = await ctx.ui.select(label, [...labels, "Done", "Cancel"], { signal });
          if (answer === "Done") {
            if (
              selected.length < (field.minItems ?? 0) ||
              selected.length > (field.maxItems ?? Infinity)
            ) {
              ctx.ui.notify("Select the required number of values", "warning");
              continue;
            }
            content[name] = selected;
            break;
          }
          const value = options[labels.indexOf(answer ?? "")]?.value;
          if (value === undefined) return { action: "cancel" };
          const index = selected.indexOf(value);
          if (index < 0) selected.push(value);
          else selected.splice(index, 1);
        }
      } else if (options) {
        const labels = options.map((item, i) => `${i + 1}. ${displayText(item.label)}`);
        const answer = await ctx.ui.select(label, labels, { signal });
        const value = options[labels.indexOf(answer ?? "")]?.value;
        if (value === undefined) return { action: "cancel" };
        content[name] = value;
      } else if (field.type === "boolean") {
        const answer = await ctx.ui.select(label, ["true", "false"], { signal });
        if (answer === undefined) return { action: "cancel" };
        content[name] = answer === "true";
      } else {
        for (;;) {
          const answer = await ctx.ui.input(
            label,
            "default" in field && field.default !== undefined
              ? `Suggested: ${displayText(String(field.default))}`
              : undefined,
            { signal },
          );
          if (answer === undefined) return { action: "cancel" };
          const numeric = field.type === "number" || field.type === "integer";
          const value = numeric ? Number(answer) : answer;
          const checked = validator.getValidator<Value>(field)(value);
          if ((numeric && answer.trim() === "") || !checked.valid) {
            ctx.ui.notify(displayText(checked.errorMessage ?? "Enter a number"), "warning");
            continue;
          }
          content[name] = value;
          break;
        }
      }
    }
    const validated = validator.getValidator<Record<string, Value>>(params.requestedSchema)(
      content,
    );
    if (!validated.valid)
      throw new Error(displayText(`Invalid MCP form response: ${validated.errorMessage}`));
    const submit = await ctx.ui.select(
      `${title}\n${displayText(JSON.stringify(content, null, 2))}`,
      ["Accept", "Decline", "Cancel"],
      { signal },
    );
    signal.throwIfAborted();
    return submit === "Accept"
      ? { action: "accept", content }
      : { action: submit === "Decline" ? "decline" : "cancel" };
  });
};
