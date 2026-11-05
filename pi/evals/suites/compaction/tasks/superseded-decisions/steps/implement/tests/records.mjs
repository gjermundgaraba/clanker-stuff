/** @param {unknown} value @returns {value is Record<string, unknown>} */
export const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
