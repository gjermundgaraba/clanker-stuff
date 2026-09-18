/** @typedef {{type: "receive"|"ship"|"adjust", sku: string, quantity: number, line: number}} LedgerEvent */
/** @param {string} input @returns {LedgerEvent[]} */
export function parseEvents(input) {
  // oxlint-disable-next-line typescript/no-unsafe-return -- This benchmark deliberately starts with an unvalidated JSON parser; validating it here would solve the task before the evaluated agent runs.
  return (
    input
      .trim()
      .split("\n")
      // oxlint-disable-next-line typescript/no-unsafe-return -- This unsafe parse callback is the deliberate benchmark defect described above, not production boundary validation.
      .map((line, index) => ({
        ...JSON.parse(line),
        line: index + 1,
      }))
  );
}

/** @param {LedgerEvent[]} events */
export function applyEvents(events) {
  /** @type {Map<string, number>} */
  const stock = new Map();

  for (const event of events) {
    stock.set(event.sku, (stock.get(event.sku) ?? 0) + event.quantity);
  }

  return stock;
}
