import type { Tone } from "@clanker-stuff/pi-tones";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { SubagentsConfig } from "./config.js";

export type DelegationPolicy = SubagentsConfig["delegation"];

const STATE_TYPE = "subagents-delegation";

const ACTIVE: Tone = "accent";

const ownedEntry = (session: Pick<ExtensionContext["sessionManager"], "getBranch">) =>
  session
    .getBranch()
    .findLast((entry) => entry.type === "custom" && entry.customType === STATE_TYPE);

export const readDelegation = (
  session: Pick<ExtensionContext["sessionManager"], "getBranch">,
  fallback: DelegationPolicy,
): DelegationPolicy => {
  const entry = ownedEntry(session);

  if (entry?.type !== "custom") return fallback;

  return entry.data === "explicit" || entry.data === "proactive" ? entry.data : "explicit";
};

export const inheritDelegation = (pi: ExtensionAPI, policy: DelegationPolicy | undefined): void => {
  if (policy === undefined) return;

  pi.on("session_start", (_event, ctx) => {
    if (ownedEntry(ctx.sessionManager) === undefined) pi.appendEntry(STATE_TYPE, policy);
  });
};

export const createDelegation = (pi: ExtensionAPI, defaultPolicy: DelegationPolicy) => {
  const status = (ctx: ExtensionContext, policy: DelegationPolicy): void => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(
      "proactive",
      policy === "proactive" ? ctx.ui.theme.fg(ACTIVE, "✦ proactive delegation") : undefined,
    );
  };

  const persist = (ctx: ExtensionContext, policy: DelegationPolicy): void => {
    pi.appendEntry(STATE_TYPE, policy);
    status(ctx, policy);
  };

  const refresh = (ctx: ExtensionContext): void =>
    status(ctx, readDelegation(ctx.sessionManager, defaultPolicy));

  const ultra = (args: string, ctx: ExtensionContext): void => {
    if (args.trim() !== "") {
      if (ctx.hasUI) ctx.ui.notify("Usage: /ultra", "warning");

      return;
    }

    const entry = ownedEntry(ctx.sessionManager);

    if (entry?.type !== "custom" || entry.data !== "proactive") persist(ctx, "proactive");
    else status(ctx, "proactive");

    if (ctx.model !== undefined) pi.setThinkingLevel("max");

    if (ctx.hasUI)
      ctx.ui.notify(
        ctx.model === undefined
          ? "Proactive delegation enabled; no model selected for Ultra thinking."
          : `Proactive delegation enabled; native thinking is ${pi.getThinkingLevel()}.`,
        "info",
      );
  };

  return {
    start: (event: SessionStartEvent, ctx: ExtensionContext): void => {
      if (event.reason === "startup" && pi.getFlag("ultra") === true) ultra("", ctx);
      else refresh(ctx);
    },
    refresh,
    toggle: (args: string, ctx: ExtensionContext): void => {
      if (args.trim() !== "") {
        if (ctx.hasUI) ctx.ui.notify("Usage: /proactive", "warning");

        return;
      }

      const policy =
        readDelegation(ctx.sessionManager, defaultPolicy) === "proactive"
          ? "explicit"
          : "proactive";

      persist(ctx, policy);

      if (ctx.hasUI)
        ctx.ui.notify(
          policy === "proactive"
            ? "Proactive delegation enabled; delegation can increase usage."
            : "Proactive delegation disabled; explicit delegation is enabled.",
          "info",
        );
    },
    ultra,
    stop: (ctx: ExtensionContext): void => {
      if (ctx.hasUI) ctx.ui.setStatus("proactive", undefined);
    },
  };
};
