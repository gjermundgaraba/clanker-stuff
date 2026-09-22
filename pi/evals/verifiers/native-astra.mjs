/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** @param {unknown} trajectory */
// Native Codex is a harness comparison, not a third Pi tool-mode arm.
export function validateNativeAstra(trajectory) {
  if (!isRecord(trajectory) || !isRecord(trajectory.agent) || !isRecord(trajectory.agent.extra)) {
    return { valid_experiment: 0 };
  }

  const { pi_evals: manifest, native_turn_contexts: contexts } = trajectory.agent.extra;

  const expected = {
    platform: "codex-native",
    compaction_mode: "off",
    expected_mechanism: "codex-native",
    expected_protocol: null,
  };

  const valid =
    isRecord(manifest) &&
    Object.keys(manifest).length === Object.keys(expected).length &&
    Object.entries(expected).every(
      ([key, value]) => Object.hasOwn(manifest, key) && manifest[key] === value,
    ) &&
    Array.isArray(contexts) &&
    contexts.length > 0 &&
    contexts.every(
      (context) =>
        isRecord(context) && context.model === "gpt-6-astra" && context.effort === "high",
    ) &&
    Array.isArray(trajectory?.steps) &&
    trajectory.steps.length > 0 &&
    !trajectory.steps.some(
      (step) =>
        isRecord(step) && isRecord(step.extra) && step.extra.event_type === "context_compaction",
    );

  return { valid_experiment: Number(valid) };
}
