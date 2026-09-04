// The delegation policy text in this file was adapted for this package from OpenAI Codex (Apache-2.0); see ../NOTICE and ../UPSTREAM.
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { requestCollaborationContract } from "../collaboration.js";
import type { CodexUltraSettings } from "../model-catalog.js";

const ULTRA_STATE = "codex-ultra-state";
const CATALOG_REFRESH_TIMEOUT_MS = 15_000;
const UltraStateSchema = Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false });
const PROACTIVE_POLICY =
  "Proactive multi-agent delegation is active. Any earlier developer instruction requiring an explicit user request before spawning sub-agents no longer applies. This mode remains active until a later multi-agent mode developer message changes it. User requests override this hint.\n\nIf at any point you can parallelize work by delegating tasks to another agent (no matter if you are root or subagent), you should do so using collaboration tools if it could save time or improve quality.";

interface UltraCatalog {
  getUltraSettings: (model: Model<Api> | undefined) => CodexUltraSettings | undefined;
}

type BranchSession = Pick<ExtensionContext["sessionManager"], "getBranch">;

const branchUltraState = (session: BranchSession): boolean | undefined => {
  let enabled: boolean | undefined;
  for (const entry of session.getBranch()) {
    if (entry.type === "custom" && entry.customType === ULTRA_STATE) {
      enabled = Value.Check(UltraStateSchema, entry.data)
        ? Value.Parse(UltraStateSchema, entry.data).enabled
        : false;
    }
  }
  return enabled;
};

export const registerCodexUltra = (pi: ExtensionAPI, catalog: UltraCatalog): void => {
  let desired = false;
  let publishedActive: boolean | undefined;
  let refreshGeneration = 0;

  pi.registerFlag("ultra", {
    description: "Start in Codex Ultra mode",
    type: "boolean",
  });

  const publishActive = (ctx: ExtensionContext, active: boolean): void => {
    if (publishedActive === active) {
      return;
    }
    requestCollaborationContract(pi, ctx, active);
    publishedActive = active;
  };

  const disable = (ctx: ExtensionContext): void => {
    refreshGeneration += 1;
    desired = false;
    pi.appendEntry(ULTRA_STATE, { enabled: false });
    publishActive(ctx, false);
  };

  const refreshUltra = async (
    ctx: ExtensionContext,
    model: Model<Api> | undefined,
  ): Promise<boolean> => {
    if (catalog.getUltraSettings(model) !== undefined) {
      return true;
    }
    if (model?.provider !== "openai-codex" || model.api !== "openai-codex-responses") {
      return false;
    }
    await ctx.modelRegistry
      .refresh({
        force: true,
        providers: ["openai-codex"],
        signal: AbortSignal.timeout(CATALOG_REFRESH_TIMEOUT_MS),
      })
      .catch(() => undefined);
    return catalog.getUltraSettings(model) !== undefined;
  };

  const sync = (
    ctx: ExtensionContext,
    contract = requestCollaborationContract(pi, ctx),
  ): CodexUltraSettings | undefined => {
    const settings =
      desired && contract?.protocol === "v2" ? catalog.getUltraSettings(ctx.model) : undefined;
    const active = settings !== undefined;
    publishActive(ctx, active);
    if (active && branchUltraState(ctx.sessionManager) !== true) {
      pi.appendEntry(ULTRA_STATE, { enabled: true });
    }
    if (settings !== undefined && pi.getThinkingLevel() !== settings.reasoningLevel) {
      pi.setThinkingLevel(settings.reasoningLevel);
    }
    return settings;
  };

  const restoreSession = async (ctx: ExtensionContext, requested = false): Promise<void> => {
    const generation = ++refreshGeneration;
    const contract = requestCollaborationContract(pi, ctx);
    const inherited = contract?.inheritedUltra === true;
    desired = requested || (branchUltraState(ctx.sessionManager) ?? inherited);
    if (desired && contract?.protocol === "v2") {
      await refreshUltra(ctx, ctx.model);
    }
    if (generation !== refreshGeneration) {
      return;
    }
    const active = sync(ctx, contract) !== undefined;
    if (!requested) {
      return;
    }
    if (contract?.protocol !== "v2") {
      desired = false;
      ctx.ui.notify("Codex Ultra requires the companion V2 subagents extension.", "warning");
    } else if (!active) {
      desired = false;
      ctx.ui.notify("The selected model does not advertise Ultra.", "warning");
    } else {
      ctx.ui.notify("Codex Ultra enabled.", "info");
    }
  };

  pi.registerCommand("ultra", {
    description: "Toggle Codex Ultra mode",
    handler: async (_args, ctx) => {
      if (desired) {
        disable(ctx);
        ctx.ui.notify(
          "Codex Ultra disabled; the current reasoning level remains selected.",
          "info",
        );
        return;
      }
      await restoreSession(ctx, true);
    },
  });

  pi.on("session_start", async (event, ctx) => {
    publishedActive = undefined;
    await restoreSession(ctx, event.reason === "startup" && pi.getFlag("ultra") === true);
  });

  pi.on("session_tree", async (_event, ctx) => {
    await restoreSession(ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    const generation = ++refreshGeneration;
    let supported = catalog.getUltraSettings(event.model) !== undefined;
    if (desired && !supported) {
      supported = await refreshUltra(ctx, event.model);
    }
    if (generation !== refreshGeneration) {
      return;
    }
    if (desired && !supported) {
      disable(ctx);
      return;
    }
    sync(ctx);
  });

  pi.on("thinking_level_select", (event, ctx) => {
    if (event.level !== catalog.getUltraSettings(ctx.model)?.reasoningLevel) {
      sync(ctx);
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    const settings = sync(ctx);
    if (settings === undefined) {
      return undefined;
    }
    const policy = settings.proactivePolicy ?? PROACTIVE_POLICY;
    return policy.length === 0
      ? undefined
      : {
          systemPrompt: `${event.systemPrompt.trimEnd()}\n\n<multi_agent_mode>${policy}</multi_agent_mode>`,
        };
  });

  pi.on("session_shutdown", (_event, ctx) => {
    refreshGeneration += 1;
    desired = false;
    publishActive(ctx, false);
    publishedActive = undefined;
  });
};
