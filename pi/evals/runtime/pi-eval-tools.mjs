// Loaded instead of index.ts only by Harbor's tool-mode experiment.
import { createHash } from "node:crypto";
import { createJournal } from "./eval-journal.mjs";
import provider from "/opt/codex-provider/index.ts";

/** @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi */
export default function evaluationExtension(pi) {
  const mode = process.env.PI_EVAL_TOOL_MODE;

  if (mode !== "direct" && mode !== "code_mode_only") {
    throw new Error("PI_EVAL_TOOL_MODE must be explicit");
  }

  provider(pi, mode);

  const expected =
    mode === "direct"
      ? ["apply_patch", "exec_command", "view_image", "write_stdin"]
      : ["exec", "wait"];

  let compacted = false;
  const { emit } = createJournal("/logs/agent/eval-events.jsonl");
  pi.on("session_before_compact", async () => {
    compacted = true;
    await emit({ type: "pi_eval_compaction", timestamp: Date.now() });

    return { cancel: true };
  });
  pi.on("session_start", async (_event, ctx) => {
    await emit({
      type: "pi_eval_setup",
      mode,
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
      !compacted &&
      model === process.env.PI_EVAL_MODEL &&
      thinking === process.env.PI_EVAL_THINKING &&
      JSON.stringify(activeTools) === JSON.stringify(expected);

    await emit({
      type: "pi_eval_tools",
      timestamp: Date.now(),
      mode,
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
