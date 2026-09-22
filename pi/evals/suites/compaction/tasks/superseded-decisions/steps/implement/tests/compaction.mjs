// The trajectory is external evidence. Validate containers before reading fields;
// retain malformed field values so one failed metric cannot hide independent results.
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * @param {unknown} value
 * @returns {value is {platform: string, compaction_mode: "on" | "off", expected_mechanism: string, expected_protocol: string | null}}
 */
const isManifest = (value) => {
  if (!isRecord(value)) return false;
  const keys = ["compaction_mode", "expected_mechanism", "expected_protocol", "platform"];

  return (
    keys.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => keys.includes(key)) &&
    typeof value.platform === "string" &&
    value.platform.trim() !== "" &&
    (value.compaction_mode === "on" || value.compaction_mode === "off") &&
    typeof value.expected_mechanism === "string" &&
    value.expected_mechanism.trim() !== "" &&
    (value.expected_protocol === null ||
      (typeof value.expected_protocol === "string" && value.expected_protocol.trim() !== ""))
  );
};

/** @param {unknown} trajectory @param {{expectedSegments: unknown}} options */
export function validateCompaction(trajectory, { expectedSegments }) {
  const agent = isRecord(trajectory) && isRecord(trajectory.agent) ? trajectory.agent : undefined;
  const extra = isRecord(agent?.extra) ? agent.extra : undefined;
  const manifest = isRecord(extra?.pi_evals) ? extra.pi_evals : undefined;
  /** @type {unknown[]} */
  const expected = Array.isArray(expectedSegments) ? expectedSegments : [];
  const manifestValid = isManifest(manifest);

  const expectedValid =
    Array.isArray(expectedSegments) &&
    expected.every((value) => typeof value === "number" && Number.isInteger(value) && value >= 0) &&
    (manifest?.compaction_mode === "off" || expected.length > 0);

  /** @type {unknown[]} */
  const rawSteps = isRecord(trajectory) && Array.isArray(trajectory.steps) ? trajectory.steps : [];

  const steps = rawSteps.map((value) => {
    const step = isRecord(value) ? value : undefined;

    return { source: step?.source, extra: isRecord(step?.extra) ? step.extra : undefined };
  });

  const attempts = steps.filter((step) => step.extra?.event_type === "context_compaction");

  const agentErrors = steps.some(
    (step) =>
      step.source === "agent" &&
      step.extra?.event_type !== "context_compaction" &&
      (step.extra?.stop_reason === "aborted" || step.extra?.stop_reason === "error"),
  );

  const finalUser = steps.findLastIndex((step) => step.source === "user");

  const finalCompaction = steps.findLastIndex(
    (step) => step.extra?.event_type === "context_compaction",
  );

  const on = manifest?.compaction_mode === "on";
  const off = manifest?.compaction_mode === "off";
  const instructionDelivered = finalUser >= 0 && (!on || finalUser > finalCompaction);

  const continuationSteps = steps.filter(
    (step, index) =>
      instructionDelivered &&
      index > finalUser &&
      step.source === "agent" &&
      step.extra?.event_type !== "context_compaction",
  );

  const agentContinuation =
    continuationSteps.length > 0 &&
    continuationSteps.every(
      (step) => !(step.extra?.stop_reason === "aborted" || step.extra?.stop_reason === "error"),
    );

  const countMatches = attempts.length === expected.length;
  const noAttempts = attempts.length === 0;

  /** @param {(attempt: typeof steps[number], index: number) => boolean} predicate */
  const attemptMetric = (predicate) =>
    Number((off && noAttempts) || (on && countMatches && attempts.every(predicate)));

  const mechanismValid = attemptMetric(
    (attempt) =>
      attempt.extra?.mechanism === manifest?.expected_mechanism &&
      attempt.extra?.protocol === manifest?.expected_protocol,
  );

  const boundaryValid = attemptMetric(
    (attempt, index) => attempt.extra?.compacted_after_segment === expected[index],
  );

  const outcomeValid = attemptMetric(
    (attempt) => attempt.source === "agent" && attempt.extra?.state === "succeeded",
  );

  const treatmentValid = Boolean(expectedValid && mechanismValid && boundaryValid && outcomeValid);
  const successes = attempts.filter((attempt) => attempt.extra?.state === "succeeded").length;

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
