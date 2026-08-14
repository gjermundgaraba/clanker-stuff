export function parseEvents(input) {
  return input
    .trim()
    .split("\n")
    .map((line, index) => ({
      ...JSON.parse(line),
      line: index + 1,
    }));
}

export function applyEvents(events) {
  const stock = new Map();
  for (const event of events) {
    stock.set(event.sku, (stock.get(event.sku) ?? 0) + event.quantity);
  }
  return stock;
}
