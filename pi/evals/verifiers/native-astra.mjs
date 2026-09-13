// Native Codex is a harness comparison, not a third Pi tool-mode arm.
export function validateNativeAstra(trajectory) {
  const manifest = trajectory?.agent?.extra?.pi_evals;
  const contexts = trajectory?.agent?.extra?.native_turn_contexts;
  const expected = {
    platform: "codex-native",
    compaction_mode: "off",
    expected_mechanism: "codex-native",
    expected_protocol: null,
  };
  const valid =
    manifest != null &&
    Object.keys(manifest).length === Object.keys(expected).length &&
    Object.entries(expected).every(
      ([key, value]) => Object.hasOwn(manifest, key) && manifest[key] === value,
    ) &&
    Array.isArray(contexts) &&
    contexts.length > 0 &&
    contexts.every((context) => context?.model === "gpt-6-astra" && context?.effort === "high") &&
    Array.isArray(trajectory?.steps) &&
    trajectory.steps.length > 0 &&
    !trajectory.steps.some((step) => step.extra?.event_type === "context_compaction");
  return { valid_experiment: Number(valid) };
}
