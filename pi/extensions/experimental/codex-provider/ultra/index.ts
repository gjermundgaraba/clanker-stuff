import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { requestCollaborationContract } from "../collaboration.js";

const ULTRA_STATE = "codex-ultra-state";
const CATALOG_REFRESH_TIMEOUT_MS = 15_000;
const UltraStateSchema = Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false });
const PROACTIVE_POLICY =
  "<multi_agent_mode>Proactive multi-agent delegation is active. Any earlier instruction requiring an explicit user request before spawning sub-agents no longer applies. Use sub-agents when parallel work would materially improve speed or quality. This mode remains active until a later multi-agent mode instruction changes it.</multi_agent_mode>";

interface UltraCatalog {
  supportsUltra: (model: Model<Api> | undefined) => boolean;
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
    if (catalog.supportsUltra(model)) {
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
    return catalog.supportsUltra(model);
  };

  const sync = (
    ctx: ExtensionContext,
    contract = requestCollaborationContract(pi, ctx),
  ): boolean => {
    const active = desired && contract?.protocol === "v2" && catalog.supportsUltra(ctx.model);
    publishActive(ctx, active);
    if (active && branchUltraState(ctx.sessionManager) !== true) {
      pi.appendEntry(ULTRA_STATE, { enabled: true });
    }
    if (active && pi.getThinkingLevel() !== "max") {
      pi.setThinkingLevel("max");
    }
    return active;
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
    const active = sync(ctx, contract);
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
        ctx.ui.notify("Codex Ultra disabled; Max remains native Max.", "info");
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
    let supported = catalog.supportsUltra(event.model);
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
    if (event.level !== "max") {
      sync(ctx);
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (!sync(ctx)) {
      return undefined;
    }
    return { systemPrompt: `${event.systemPrompt.trimEnd()}\n\n${PROACTIVE_POLICY}` };
  });

  pi.on("session_shutdown", (_event, ctx) => {
    refreshGeneration += 1;
    desired = false;
    publishActive(ctx, false);
    publishedActive = undefined;
  });
};
