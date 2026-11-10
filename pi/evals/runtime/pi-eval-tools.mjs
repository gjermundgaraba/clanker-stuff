import { createHash } from "node:crypto";

import { createCodemodeExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { createJournal } from "./eval-journal.mjs";

const DirectToolsSchema = Type.Array(Type.String({ pattern: String.raw`\S` }), {
  minItems: 1,
  uniqueItems: true,
});

/** @param {"direct" | "code_mode_only"} mode */
const controlledTools = (mode) => {
  /** @type {unknown} */
  const direct = JSON.parse(process.env["PI_EVAL_DIRECT_TOOLS"] ?? "null");

  if (!Value.Check(DirectToolsSchema, direct) || direct.includes("codemode")) {
    throw new Error(
      "Controlled comparisons require an explicit direct tool inventory"
    );
  }

  return (mode === "direct" ? direct : [...direct, "codemode"]).toSorted();
};

/** @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi Extension API of the Pi session under evaluation. */
export default async function evaluationExtension(pi) {
  const mode = process.env["PI_EVAL_TOOL_MODE"];

  if (mode !== "direct" && mode !== "code_mode_only") {
    throw new Error("PI_EVAL_TOOL_MODE must be explicit");
  }

  const controlled = process.env["PI_EVAL_EXPERIMENT"] === "code-mode";

  if (mode === "code_mode_only") {
    await createCodemodeExtension(
      controlled ? { mode: "only", models: false } : {}
    )(pi);
  }

  const expected = controlled ? controlledTools(mode) : undefined;

  const matchesTools = () =>
    expected === undefined
      ? pi.getActiveTools().includes("codemode") === (mode === "code_mode_only")
      : JSON.stringify(pi.getActiveTools().toSorted()) ===
        JSON.stringify(expected);

  pi.registerCommand("eval-preflight", {
    description: "Check evaluation startup without making a model request",
    handler: async () => undefined,
  });

  /** @param {import('@earendil-works/pi-coding-agent').ExtensionContext} ctx */
  const loadout = (ctx) => ({
    mode: controlled ? mode : "native",
    activeTools: pi.getActiveTools().toSorted(),
    model: `${ctx.model?.provider}/${ctx.model?.id}`,
    thinking: pi.getThinkingLevel(),
  });

  let compacted = false;
  const { emit } = createJournal("/logs/agent/eval-events.jsonl");
  pi.on("session_before_compact", async () => {
    compacted = true;
    await emit({ type: "pi_eval_compaction", timestamp: Date.now() });

    return controlled ? { cancel: true } : undefined;
  });
  pi.on("session_start", async (_event, ctx) => {
    if (expected !== undefined) {
      pi.setActiveTools(expected);
    }

    if (!matchesTools()) {
      throw new Error(
        "Evaluation arm does not match the effective native tool loadout"
      );
    }

    await emit({ type: "pi_eval_setup", ...loadout(ctx) });
  });
  pi.on("before_provider_request", async (_event, ctx) => {
    const current = loadout(ctx);

    const valid =
      (!controlled || !compacted) &&
      current.model === process.env["PI_EVAL_MODEL"] &&
      (process.env["PI_EVAL_THINKING"] === undefined ||
        current.thinking === process.env["PI_EVAL_THINKING"]) &&
      matchesTools();

    await emit({
      type: "pi_eval_tools",
      timestamp: Date.now(),
      ...current,
      valid,
      systemPromptSha256: createHash("sha256")
        .update(ctx.getSystemPrompt())
        .digest("hex"),
    });

    if (!valid) {
      ctx.abort();
      throw new Error("Harbor tool-mode runtime contract violated");
    }
  });
}
