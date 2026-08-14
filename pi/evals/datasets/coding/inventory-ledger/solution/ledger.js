const lineError = (ErrorType, line, message) =>
  new ErrorType(`line ${line}: ${message}`);

export function parseEvents(input) {
  const events = [];
  for (const [index, source] of input.split("\n").entries()) {
    const line = index + 1;
    if (!source.trim() || source.trimStart().startsWith("#")) continue;
    let event;
    try {
      event = JSON.parse(source);
    } catch (error) {
      throw lineError(SyntaxError, line, error.message);
    }
    if (event === null || typeof event !== "object" || Array.isArray(event)) {
      throw lineError(TypeError, line, "event must be an object");
    }
    const sku =
      typeof event.sku === "string" ? event.sku.trim().toUpperCase() : "";
    const validType = ["receive", "ship", "adjust"].includes(event.type);
    const validQuantity =
      Number.isInteger(event.quantity) &&
      (event.type === "adjust" ? event.quantity >= 0 : event.quantity > 0);
    if (!sku || !validType || !validQuantity) {
      throw lineError(TypeError, line, "invalid event");
    }
    events.push({ type: event.type, sku, quantity: event.quantity, line });
  }
  return events;
}

export function applyEvents(events) {
  const stock = new Map();
  for (const event of events) {
    const current = stock.get(event.sku) ?? 0;
    const next =
      event.type === "adjust"
        ? event.quantity
        : current +
          (event.type === "receive" ? event.quantity : -event.quantity);
    if (next < 0)
      throw new RangeError(`${event.sku} below zero at line ${event.line}`);
    stock.set(event.sku, next);
  }
  return stock;
}
