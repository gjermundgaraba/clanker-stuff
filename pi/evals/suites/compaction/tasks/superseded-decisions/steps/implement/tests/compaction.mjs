const isObject = (value) => value !== null && !Array.isArray(value) && value === Object(value);
const isSegment = (value) => Number.isInteger(value) && value >= 0;
const isString = (value) => value === String(value);

export function validateCompaction(trajectory, { expectedSegments }) {
  const manifest = trajectory?.agent?.extra?.pi_evals;
  const expected = Array.isArray(expectedSegments) ? expectedSegments : [];
  const manifestKeys = ["compaction_mode", "expected_mechanism", "expected_protocol", "platform"];
  const manifestValid =
    isObject(manifest) &&
    manifestKeys.every((key) => Object.hasOwn(manifest, key)) &&
    Object.keys(manifest).every((key) => manifestKeys.includes(key)) &&
    isString(manifest.platform) &&
    manifest.platform.trim() !== "" &&
    (manifest.compaction_mode === "on" || manifest.compaction_mode === "off") &&
    isString(manifest.expected_mechanism) &&
    manifest.expected_mechanism.trim() !== "" &&
    (manifest.expected_protocol === null ||
      (isString(manifest.expected_protocol) && manifest.expected_protocol.trim() !== ""));
  const expectedValid =
    Array.isArray(expectedSegments) &&
    expected.every(isSegment) &&
    (manifest?.compaction_mode === "off" || expected.length > 0);
  const steps = Array.isArray(trajectory?.steps) ? trajectory.steps : [];
  const attempts = steps.filter((step) => step?.extra?.event_type === "context_compaction");
  const agentErrors = steps.some(
    (step) =>
      step?.source === "agent" &&
      step?.extra?.event_type !== "context_compaction" &&
      ["aborted", "error"].includes(step?.extra?.stop_reason),
  );
  const finalUser = steps.findLastIndex((step) => step?.source === "user");
  const finalCompaction = steps.findLastIndex(
    (step) => step?.extra?.event_type === "context_compaction",
  );
  const on = manifest?.compaction_mode === "on";
  const off = manifest?.compaction_mode === "off";
  const instructionDelivered = finalUser >= 0 && (!on || finalUser > finalCompaction);
  const continuationSteps = steps.filter(
    (step, index) =>
      instructionDelivered &&
      index > finalUser &&
      step?.source === "agent" &&
      step?.extra?.event_type !== "context_compaction",
  );
  const agentContinuation =
    continuationSteps.length > 0 &&
    continuationSteps.every((step) => !["aborted", "error"].includes(step?.extra?.stop_reason));
  const countMatches = attempts.length === expected.length;
  const noAttempts = attempts.length === 0;
  const attemptMetric = (predicate) =>
    Number((off && noAttempts) || (on && countMatches && attempts.every(predicate)));
  const mechanismValid = attemptMetric(
    (attempt) =>
      attempt?.extra?.mechanism === manifest.expected_mechanism &&
      attempt?.extra?.protocol === manifest.expected_protocol,
  );
  const boundaryValid = attemptMetric(
    (attempt, index) => attempt?.extra?.compacted_after_segment === expected[index],
  );
  const outcomeValid = attemptMetric(
    (attempt) => attempt?.source === "agent" && attempt?.extra?.state === "succeeded",
  );
  const treatmentValid = Boolean(expectedValid && mechanismValid && boundaryValid && outcomeValid);
  const successes = attempts.filter((attempt) => attempt?.extra?.state === "succeeded").length;
  return {
    valid_experiment: Number(
      manifestValid && instructionDelivered && agentContinuation && treatmentValid,
    ),
    compaction_attempts: attempts.length,
    compaction_successes: successes,
    compaction_failures: attempts.length - successes,
    mechanism_valid: mechanismValid,
    boundary_valid: boundaryValid,
    outcome_valid: outcomeValid,
    instruction_delivered: Number(instructionDelivered),
    agent_continuation: Number(agentContinuation),
    agent_errors: Number(agentErrors),
    manifest_valid: Number(manifestValid),
  };
}
