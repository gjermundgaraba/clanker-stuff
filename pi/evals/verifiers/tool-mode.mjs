// Runtime validity is independent of task quality and successful completion.
export function validateToolMode(
  trajectory,
  { directTools = ["apply_patch", "exec_command", "view_image", "write_stdin"] } = {},
) {
  const manifest = trajectory?.agent?.extra?.pi_evals;
  const evidence = trajectory?.agent?.extra?.tool_mode_evidence ?? [];
  const requests = evidence.filter((event) => event.type === "pi_eval_tools");
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
    manifest.pair_id === String(manifest.pair_id) &&
    manifest.pair_id.trim().length > 0 &&
    !(trajectory.steps ?? []).some((step) => step.extra?.event_type === "context_compaction") &&
    ["direct", "code"].includes(manifest.arm) &&
    manifest.tool_mode === mode &&
    manifest.compaction_mode === "off" &&
    requests.length > 0 &&
    evidence.length === requests.length &&
    requests.every(
      (event) =>
        event.valid === true &&
        event.mode === mode &&
        event.model === "openai-codex/gpt-6-astra" &&
        event.thinking === "high" &&
        JSON.stringify(event.activeTools) === JSON.stringify(expected),
    );
  return { valid_experiment: Number(valid) };
}
