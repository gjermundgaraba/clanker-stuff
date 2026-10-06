import type { Tone } from "@clanker-stuff/pi-tones";
import type {
  BeforeProviderRequestEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { loadFastDefault } from "./config.js";
import { canRequestPriority } from "./models.js";

const ACTIVE: Tone = "accent";

const PayloadSchema = Type.Object({ model: Type.String() }, { additionalProperties: true });

export const createFastMode = (
  pi: ExtensionAPI,
  configPath: string,
  loadDefault: typeof loadFastDefault = loadFastDefault,
) => {
  let enabled = false;
  let stopped = false;

  const refresh = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("fast", enabled ? ctx.ui.theme.fg(ACTIVE, "⚡ Fast requested") : undefined);
  };

  const notify = (ctx: ExtensionContext, message: string, type: "info" | "warning"): void => {
    if (ctx.hasUI) ctx.ui.notify(message, type);
  };

  return {
    async start(event: SessionStartEvent, ctx: ExtensionContext): Promise<void> {
      if (stopped) return;

      try {
        const saved = await loadDefault(configPath);

        if (stopped) return;
        enabled = saved || (event.reason === "startup" && pi.getFlag("fast") === true);
      } catch (error) {
        if (stopped) return;
        enabled = event.reason === "startup" && pi.getFlag("fast") === true;
        notify(
          ctx,
          `Failed to load ${configPath}; using the local startup flag or Fast off: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      }

      refresh(ctx);
    },
    payload(event: BeforeProviderRequestEvent, ctx: ExtensionContext) {
      if (
        !enabled ||
        !canRequestPriority(ctx) ||
        !Value.Check(PayloadSchema, event.payload) ||
        event.payload.model !== ctx.model?.id
      )
        return undefined;

      return { ...event.payload, service_tier: "priority" };
    },
    toggle(args: string, ctx: ExtensionContext): void {
      if (stopped) return;

      if (args.trim() !== "") {
        notify(ctx, "Usage: /fast", "warning");

        return;
      }

      enabled = !enabled;
      refresh(ctx);
      notify(ctx, `Fast requests ${enabled ? "enabled" : "disabled"} in this runtime.`, "info");
    },
    stop(ctx: ExtensionContext): void {
      stopped = true;
      enabled = false;
      refresh(ctx);
    },
  };
};
