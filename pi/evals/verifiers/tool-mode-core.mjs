/** @param {unknown} value @returns {value is Record<string, unknown>} */
// oxlint-disable-next-line anti-slop/no-runtime-typeof -- This standalone verifier uses a real JSDoc predicate; the syntax-only rule recognizes only TypeScript predicate annotations.
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** @param {unknown} trajectory @param {{directTools?: string[]}} options */
// Runtime validity is independent of task quality and successful completion.
export function validateToolMode(
  trajectory,
  { directTools = ["apply_patch", "exec_command", "view_image", "write_stdin"] } = {},
) {
  const agent = isRecord(trajectory) && isRecord(trajectory.agent) ? trajectory.agent : undefined;
  const extra = isRecord(agent?.extra) ? agent.extra : undefined;
  const manifest = isRecord(extra?.pi_evals) ? extra.pi_evals : undefined;
  /** @type {unknown[]} */
  const evidence = Array.isArray(extra?.tool_mode_evidence) ? extra.tool_mode_evidence : [];
  const steps = isRecord(trajectory) ? trajectory.steps : undefined;
  const expected = manifest?.arm === "direct" ? directTools : ["exec", "wait"];
  const mode = manifest?.arm === "direct" ? "direct" : "code_mode_only";

  const keys = [
    "platform",
    "compaction_mode",
    "expected_mechanism",
    "expected_protocol",
    "experiment",
    "arm",
    "tool_mode",
    "pair_id",
  ];

  const valid =
    manifest?.experiment === "code-mode" &&
    Object.keys(manifest).length === keys.length &&
    keys.every((key) => Object.hasOwn(manifest, key)) &&
    manifest.platform === "pi-provider" &&
    manifest.expected_mechanism === "codex-provider" &&
    manifest.expected_protocol === "openai-responses-compaction-v2" &&
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Pair identity is an external manifest field; require a nonempty string as part of this complete arm-contract validation.
    typeof manifest.pair_id === "string" &&
    manifest.pair_id.trim().length > 0 &&
    (steps === undefined ||
      (Array.isArray(steps) &&
        !steps.some(
          (step) =>
            isRecord(step) &&
            isRecord(step.extra) &&
            step.extra.event_type === "context_compaction",
        ))) &&
    (manifest.arm === "direct" || manifest.arm === "code") &&
    manifest.tool_mode === mode &&
    manifest.compaction_mode === "off" &&
    evidence.length > 0 &&
    evidence.every(
      (event) =>
        isRecord(event) &&
        event.type === "pi_eval_tools" &&
        event.valid === true &&
        event.mode === mode &&
        event.model === "openai-codex/gpt-6-astra" &&
        event.thinking === "high" &&
        JSON.stringify(event.activeTools) === JSON.stringify(expected),
    );

  return { valid_experiment: Number(valid) };
}
