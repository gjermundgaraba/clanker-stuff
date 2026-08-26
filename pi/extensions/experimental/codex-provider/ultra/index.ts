import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { requestCollaborationContract, setCollaborationUltraReader } from "../collaboration.js";

const ULTRA_STATE = "codex-ultra-state";
const CATALOG_REFRESH_TIMEOUT_MS = 15_000;
const POLICY_START = "<multi_agent_mode>";
const POLICY_END = "</multi_agent_mode>";
const UltraStateSchema = Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false });
const PROACTIVE_POLICY = `${POLICY_START}Proactive multi-agent delegation is active. Any earlier instruction requiring an explicit user request before spawning sub-agents no longer applies. Use sub-agents when parallel work would materially improve speed or quality. This mode remains active until a later multi-agent mode instruction changes it.${POLICY_END}`;

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

export const resolveUltraFromBranch = (session: BranchSession): boolean =>
  branchUltraState(session) ?? false;

export const appendUltraInstructions = (prompt: string): string => {
  const start = prompt.indexOf(POLICY_START);
  const end = start === -1 ? -1 : prompt.indexOf(POLICY_END, start);
  const base =
    start === -1 || end === -1
      ? prompt.trimEnd()
      : `${prompt.slice(0, start).trimEnd()}${prompt.slice(end + POLICY_END.length)}`.trimEnd();
  return `${base}\n\n${PROACTIVE_POLICY}`;
};

export const registerCodexUltra = (pi: ExtensionAPI, catalog: UltraCatalog): void => {
  let changingThinking = false;
  let enabled = false;
  let sessionEpoch = 0;

  setCollaborationUltraReader(pi, () => enabled);

  const persist = (next: boolean): void => {
    if (enabled === next) {
      return;
    }
    enabled = next;
    pi.appendEntry(ULTRA_STATE, { enabled: next });
  };

  const selectMax = (): void => {
    if (pi.getThinkingLevel() === "max") {
      return;
    }
    changingThinking = true;
    pi.setThinkingLevel("max");
    changingThinking = false;
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
    try {
      await ctx.modelRegistry.refresh({
        force: true,
        providers: ["openai-codex"],
        signal: AbortSignal.timeout(CATALOG_REFRESH_TIMEOUT_MS),
      });
    } catch {
      // Missing live metadata keeps Ultra disabled.
    }
    return catalog.supportsUltra(model);
  };

  const restore = (
    session: BranchSession,
    model: Model<Api> | undefined,
    collaborationAvailable: boolean,
    inherited: boolean,
  ): void => {
    const stored = branchUltraState(session);
    enabled = (stored ?? inherited) && collaborationAvailable && catalog.supportsUltra(model);
    if (enabled && stored === undefined && inherited) {
      pi.appendEntry(ULTRA_STATE, { enabled: true });
    }
    if (enabled) {
      selectMax();
    }
  };

  const restoreSession = async (ctx: ExtensionContext): Promise<void> => {
    sessionEpoch += 1;
    const epoch = sessionEpoch;
    enabled = false;
    const contract = requestCollaborationContract(pi, ctx);
    const inherited = contract?.inheritedUltra === true;
    const desired = branchUltraState(ctx.sessionManager) ?? inherited;
    if (desired) {
      await refreshUltra(ctx, ctx.model);
    }
    if (epoch !== sessionEpoch) {
      return;
    }
    restore(ctx.sessionManager, ctx.model, contract?.protocol === "v2", inherited);
  };

  pi.registerCommand("ultra", {
    description: "Toggle Codex Ultra mode",
    handler: async (_args, ctx) => {
      if (enabled) {
        persist(false);
        ctx.ui.notify("Codex Ultra disabled; Max remains native Max.", "info");
        return;
      }
      sessionEpoch += 1;
      const epoch = sessionEpoch;
      if (requestCollaborationContract(pi, ctx)?.protocol !== "v2") {
        ctx.ui.notify("Codex Ultra requires the companion V2 subagents extension.", "warning");
        return;
      }
      const supported = await refreshUltra(ctx, ctx.model);
      if (epoch !== sessionEpoch) {
        return;
      }
      if (!supported) {
        ctx.ui.notify("The selected model does not advertise Ultra.", "warning");
        return;
      }
      persist(true);
      selectMax();
      ctx.ui.notify("Codex Ultra enabled.", "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await restoreSession(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    await restoreSession(ctx);
  });

  pi.on("model_select", (event) => {
    sessionEpoch += 1;
    if (enabled && !catalog.supportsUltra(event.model)) {
      persist(false);
    }
  });

  pi.on("thinking_level_select", (event) => {
    sessionEpoch += 1;
    if (enabled && !changingThinking && event.level !== "max") {
      persist(false);
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    let contract = requestCollaborationContract(pi, ctx);
    const inherited = contract?.inheritedUltra === true;
    if (!enabled && (branchUltraState(ctx.sessionManager) ?? inherited)) {
      sessionEpoch += 1;
      const epoch = sessionEpoch;
      await refreshUltra(ctx, ctx.model);
      if (epoch !== sessionEpoch) {
        return undefined;
      }
      restore(ctx.sessionManager, ctx.model, contract?.protocol === "v2", inherited);
      contract = requestCollaborationContract(pi, ctx);
    }
    if (!enabled) {
      return undefined;
    }
    if (contract?.protocol !== "v2") {
      enabled = false;
      return undefined;
    }
    return { systemPrompt: appendUltraInstructions(event.systemPrompt) };
  });

  pi.on("session_shutdown", () => {
    sessionEpoch += 1;
    enabled = false;
  });
};
