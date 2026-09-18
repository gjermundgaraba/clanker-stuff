// Reference receives only the public tool interface; never fixture internals.
/** @param {ReturnType<typeof import("./services.mjs").createServices>["call"]} call */
export async function solve(call) {
  /** @param {string} name @param {unknown} args Public service arguments are validated by the backend. */
  const invoke = async (name, args) => {
    const result = await call(name, args);

    if ("error" in result) throw Error(JSON.stringify(result));

    return result;
  };

  /** @param {string} collection */
  const list = async (collection) => {
    /** @type {string|null} */
    let cursor = null;
    /** @type {import("./services.mjs").LedgerEntry[]} */
    const items = [];

    do {
      const p = await invoke("list_records", { collection, cursor });

      if (!("items" in p)) throw new Error("list_records returned a non-page response");
      items.push(...p.items);
      cursor = p.next_cursor;
    } while (cursor !== null);

    return items;
  };

  const items = await list("ledger");
  /** @type {Map<string, number>} */
  const totals = new Map();

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
