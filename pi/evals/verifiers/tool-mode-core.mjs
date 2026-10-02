/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** @param {unknown} trajectory @param {{model: string, thinking: string, directTools: string[]}} options */
// Runtime validity is independent of task quality and successful completion.
export function validateToolMode(trajectory, { model, thinking, directTools }) {
  const agent = isRecord(trajectory) && isRecord(trajectory.agent) ? trajectory.agent : undefined;
  const extra = isRecord(agent?.extra) ? agent.extra : undefined;
  const manifest = isRecord(extra?.pi_evals) ? extra.pi_evals : undefined;
  /** @type {unknown[]} */
  const evidence = Array.isArray(extra?.tool_mode_evidence) ? extra.tool_mode_evidence : [];
  const steps = isRecord(trajectory) ? trajectory.steps : undefined;

  if (
    !Array.isArray(directTools) ||
    directTools.length === 0 ||
    directTools.some((t) => typeof t !== "string" || !t.trim() || t === "codemode") ||
    new Set(directTools).size !== directTools.length
  )
    return { valid_experiment: 0 };

  const manifestTools = manifest?.direct_tools;

  const expected =
    manifest?.arm === "direct" ? [...directTools].sort() : [...directTools, "codemode"].sort();

  const mode = manifest?.arm === "direct" ? "direct" : "code_mode_only";

  const keys = [
    "platform",
    "compaction_mode",
    "expected_mechanism",
    "expected_protocol",
    "direct_tools",
    "experiment",
    "arm",
    "tool_mode",
    "pair_id",
  ];

  const valid =
    manifest?.experiment === "code-mode" &&
    keys.every((key) => Object.hasOwn(manifest, key)) &&
    manifest.platform ===
      (manifest.arm === "direct" ? "pi-without-code-mode" : "pi-with-code-mode") &&
    Array.isArray(manifestTools) &&
    manifestTools.length === directTools.length &&
    directTools.every((name) => manifestTools.includes(name)) &&
    manifest.expected_mechanism === "pi-builtin" &&
    manifest.expected_protocol === null &&
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
        event.model === model &&
        event.thinking === thinking &&
        JSON.stringify(event.activeTools) === JSON.stringify(expected),
    );

  return { valid_experiment: Number(valid) };
}
