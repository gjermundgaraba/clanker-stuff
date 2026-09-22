/** @typedef {{type: "receive"|"ship"|"adjust", sku: string, quantity: number, line: number}} LedgerEvent */
/** @param {ErrorConstructor} ErrorType @param {number} line @param {string} message */
const lineError = (ErrorType, line, message) => new ErrorType(`line ${line}: ${message}`);

/** @param {string} input @returns {LedgerEvent[]} */
export function parseEvents(input) {
  /** @type {LedgerEvent[]} */
  const events = [];

  for (const [index, source] of input.split("\n").entries()) {
    const line = index + 1;

    if (!source.trim() || source.trimStart().startsWith("#")) continue;
    /** @type {unknown} */
    let event;

    try {
      event = JSON.parse(source);
    } catch (error) {
      throw lineError(SyntaxError, line, error instanceof Error ? error.message : String(error));
    }

    if (!isRecord(event)) {
      throw lineError(TypeError, line, "event must be an object");
    }

    const sku = typeof event.sku === "string" ? event.sku.trim().toUpperCase() : "";
    const { type, quantity } = event;
    const validType = type === "receive" || type === "ship" || type === "adjust";

    const validQuantity =
      typeof quantity === "number" &&
      Number.isInteger(quantity) &&
      (type === "adjust" ? quantity >= 0 : quantity > 0);

    if (!sku || !validType || !validQuantity) {
      throw lineError(TypeError, line, "invalid event");
    }

    events.push({ type, sku, quantity, line });
  }

  return events;
}

/** @param {LedgerEvent[]} events */
export function applyEvents(events) {
  /** @type {Map<string, number>} */
  const stock = new Map();

  for (const event of events) {
    const current = stock.get(event.sku) ?? 0;

    const next =
      event.type === "adjust"
        ? event.quantity
        : current + (event.type === "receive" ? event.quantity : -event.quantity);

    if (next < 0) throw new RangeError(`${event.sku} below zero at line ${event.line}`);
    stock.set(event.sku, next);
  }

  return stock;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
