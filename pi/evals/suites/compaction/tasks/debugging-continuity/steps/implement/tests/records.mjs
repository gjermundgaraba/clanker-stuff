/** @param {unknown} value @returns {value is Record<string, unknown>} */
export const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** @param {unknown} trajectory */
export const trajectoryRecords = (trajectory) => {
  const agent =
    isRecord(trajectory) && isRecord(trajectory["agent"])
      ? trajectory["agent"]
      : undefined;

  const extra = isRecord(agent?.["extra"]) ? agent["extra"] : undefined;

  return { agent, extra };
};
