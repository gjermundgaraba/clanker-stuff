import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "codex-fast";
const LIGHTNING = "⚡";

// ponytail: pi model metadata does not expose service tiers; update this allowlist with the Codex catalog.
const FAST_MODELS = new Set([
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
]);

const supportsFastMode = (model: ExtensionContext["model"]) =>
  model?.provider === "openai-codex" && FAST_MODELS.has(model.id);

export default function codexFastExtension(pi: ExtensionAPI) {
  let enabled = false;

  pi.registerFlag("fast", {
    default: false,
    description: "Start with OpenAI Codex fast mode enabled",
    type: "boolean",
  });

  const updateStatus = (ctx: ExtensionContext): void => {
    ctx.ui.setStatus(
      STATUS_KEY,
      enabled && supportsFastMode(ctx.model)
        ? ctx.ui.theme.fg("warning", LIGHTNING)
        : undefined
    );
  };

  pi.on("before_provider_request", (event, ctx) => {
    if (
      !enabled ||
      !supportsFastMode(ctx.model) ||
      typeof event.payload !== "object" ||
      event.payload === null ||
      Array.isArray(event.payload)
    ) {
      return;
    }

    return { ...event.payload, service_tier: "priority" };
  });

  pi.registerCommand("fast", {
    description: "Toggle OpenAI Codex fast mode",
    handler: (_args, ctx) => {
      enabled = !enabled;
      updateStatus(ctx);
      ctx.ui.notify(`Codex fast mode ${enabled ? "enabled" : "disabled"}`);
      return Promise.resolve();
    },
  });

  pi.on("session_start", (_event, ctx) => {
    enabled = pi.getFlag("fast") === true;
    updateStatus(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    updateStatus(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    enabled = false;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
