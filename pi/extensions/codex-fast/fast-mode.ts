import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

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

export const createFastMode = () => {
  let enabled = false;

  const refreshStatus = (ctx: ExtensionContext): void => {
    ctx.ui.setStatus(
      "codex-fast",
      enabled && supportsFastMode(ctx.model)
        ? ctx.ui.theme.fg("warning", "⚡")
        : undefined
    );
  };

  return {
    applyToRequest(payload: unknown, ctx: ExtensionContext) {
      return !enabled ||
        !supportsFastMode(ctx.model) ||
        typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload)
        ? undefined
        : { ...payload, service_tier: "priority" };
    },
    refreshStatus,
    start(initiallyEnabled: boolean, ctx: ExtensionContext): void {
      enabled = initiallyEnabled;
      refreshStatus(ctx);
    },
    toggle(ctx: ExtensionContext): void {
      enabled = !enabled;
      refreshStatus(ctx);
      ctx.ui.notify(`Codex fast mode ${enabled ? "enabled" : "disabled"}`);
    },
  };
};
