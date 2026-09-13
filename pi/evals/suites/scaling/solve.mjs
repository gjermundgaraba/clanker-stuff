// Reference receives only the public tool interface; never fixture internals.
export async function solve(call) {
  const invoke = async (name, args) => {
    const result = await call(name, args);
    if (result.error) throw Error(JSON.stringify(result));
    return result;
  };
  const list = async (collection) => {
    let cursor = null,
      items = [];
    do {
      const p = await invoke("list_records", { collection, cursor });
      items.push(...p.items);
      cursor = p.next_cursor;
    } while (cursor !== null);
    return items;
  };
  const items = await list("ledger"),
    totals = new Map();
  for (const r of items)
    if (r.status === "posted" && r.currency === "USD" && r.day >= 8 && r.day <= 24)
      totals.set(r.tenant, (totals.get(r.tenant) ?? 0) + r.amount_cents - r.refund_cents);
  const answer = {
    rows: [...totals]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tenant, net_cents]) => ({ tenant, net_cents })),
    total_cents: [...totals.values()].reduce((a, b) => a + b, 0),
  };
  await invoke("submit_report", { json: JSON.stringify(answer) });
  return answer;
}
