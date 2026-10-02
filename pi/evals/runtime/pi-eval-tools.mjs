// Evaluation policy only; execution is Pi's unmodified built-in Code Mode.
import { createHash } from "node:crypto";
import { createJournal } from "./eval-journal.mjs";
import { createCodemodeExtension } from "@earendil-works/pi-coding-agent";

/** @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi */
export default async function evaluationExtension(pi) {
  const mode = process.env.PI_EVAL_TOOL_MODE;

  if (mode !== "direct" && mode !== "code_mode_only") {
    throw new Error("PI_EVAL_TOOL_MODE must be explicit");
  }

  const controlled = process.env.PI_EVAL_EXPERIMENT === "code-mode";

  if (mode === "code_mode_only")
    await createCodemodeExtension(controlled ? { mode: "only", models: false } : {})(pi);

  /** @type {unknown} */
  const direct = controlled ? JSON.parse(process.env.PI_EVAL_DIRECT_TOOLS ?? "null") : undefined;

  const names = Array.isArray(direct) ? direct.filter((name) => typeof name === "string") : [];

  if (
    controlled &&
    (!Array.isArray(direct) ||
      names.length === 0 ||
      names.length !== direct.length ||
      names.some((name) => !name.trim() || name === "codemode") ||
      new Set(names).size !== names.length)
  )
    throw new Error("Controlled comparisons require an explicit direct tool inventory");

  const expected = controlled
    ? (mode === "direct" ? names : [...names, "codemode"]).sort((a, b) =>
        a < b ? -1 : a > b ? 1 : 0,
      )
    : undefined;

  const matchesTools = () =>
    expected === undefined
      ? pi.getActiveTools().includes("codemode") === (mode === "code_mode_only")
      : JSON.stringify(pi.getActiveTools().sort()) === JSON.stringify(expected);

  pi.registerCommand("eval-preflight", {
    description: "Check evaluation startup without making a model request",
    handler: () => Promise.resolve(),
  });

  let compacted = false;
  const { emit } = createJournal("/logs/agent/eval-events.jsonl");
  pi.on("session_before_compact", async () => {
    compacted = true;
    await emit({ type: "pi_eval_compaction", timestamp: Date.now() });

    return controlled ? { cancel: true } : undefined;
  });
  pi.on("session_start", async (_event, ctx) => {
    if (expected !== undefined) pi.setActiveTools(expected);

    if (!matchesTools()) {
      throw new Error("Evaluation arm does not match the effective native tool loadout");
    }

    await emit({
      type: "pi_eval_setup",
      mode: controlled ? mode : "native",
      activeTools: pi.getActiveTools().sort(),
      model: `${ctx.model?.provider}/${ctx.model?.id}`,
      thinking: pi.getThinkingLevel(),
    });
  });
  pi.on("before_provider_request", async (_event, ctx) => {
    const activeTools = pi.getActiveTools().sort();
    const model = `${ctx.model?.provider}/${ctx.model?.id}`;
    const thinking = pi.getThinkingLevel();

    const valid =
      (!controlled || !compacted) &&
      model === process.env.PI_EVAL_MODEL &&
      (process.env.PI_EVAL_THINKING === undefined || thinking === process.env.PI_EVAL_THINKING) &&
      matchesTools();

    await emit({
      type: "pi_eval_tools",
      timestamp: Date.now(),
      mode: controlled ? mode : "native",
      model,
      thinking,
      activeTools,
      valid,
      systemPromptSha256: createHash("sha256").update(ctx.getSystemPrompt()).digest("hex"),
    });

    if (!valid) {
      ctx.abort();
      throw new Error("Harbor tool-mode runtime contract violated");
    }
  });
}
