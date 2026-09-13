import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
export const SERVICE_NAMES = ["list_records", "submit_report"];
export function toolSpecs(Type) {
  const str = Type.String(),
    strict = { additionalProperties: false };
  return [
    [
      "list_records",
      "Paginate the ledger collection. Start cursor=null and follow next_cursor until null. Returns {items,next_cursor}. No server-side filters.",
      Type.Object(
        { collection: Type.Literal("ledger"), cursor: Type.Union([str, Type.Null()]) },
        strict,
      ),
    ],
    [
      "submit_report",
      "Submit final JSON encoded in the json string, matching the task format. No correctness feedback. Finish after submission.",
      Type.Object({ json: str }, strict),
    ],
  ];
}
export const SETTINGS = JSON.parse(readFileSync(new URL("./case.json", import.meta.url)));
export const FIXTURE = `scaling-ledger-${SETTINGS.count}-${SETTINGS.seed}-v1`;
const hash = (s) => createHash("sha256").update(s).digest("hex");
export function fixture() {
  return {
    ledger: Array.from({ length: SETTINGS.count }, (_, i) => {
      const d = createHash("sha256").update(`${SETTINGS.seed}:row:${i}`).digest();
      return {
        id: `entry-${hash(`${SETTINGS.seed}:${i}`).slice(0, 14)}`,
        tenant: `tenant-${i < 7 ? i : d[0] % 7}`,
        status: i < 7 || d[1] % 5 !== 0 ? "posted" : "pending",
        currency: i < 7 || d[2] % 11 !== 0 ? "USD" : "EUR",
        day: i < 7 ? 10 : 1 + (d[3] % 31),
        amount_cents: 1000 + (d.readUInt32LE(4) % 20000),
        refund_cents: d[8] % 9 === 0 ? d.readUInt16LE(9) % 1500 : 0,
        archived_note: "archived ".repeat(20),
      };
    }),
  };
}
/** @param {{emit?: (event: Record<string, unknown>)=>void|Promise<void>,latencyMs?:number}} options */
export function createServices({ emit = () => {}, latencyMs = 150 } = {}) {
  const data = fixture().ledger;
  const cursors = new Map([[null, 0]]);
  for (let n = SETTINGS.page_size; n < data.length; n += SETTINGS.page_size)
    cursors.set(`cursor-${hash(`${SETTINGS.seed}:cursor:${n}`).slice(0, 20)}`, n);
  const cursorAt = new Map([...cursors].map(([c, n]) => [n, c]));
  let sequence = 0,
    tail = Promise.resolve();
  const fail = (code) => ({ error: { code, retryable: false } });
  async function execute(name, args, signal) {
    const operation = ++sequence,
      start_ms = Date.now();
    await emit({ type: "pi_eval_service_start", operation, name, args, start_ms, concurrent: 1 });
    let result;
    try {
      await delay(latencyMs, undefined, { signal });
      if (operation > SETTINGS.budget && name !== "submit_report") result = fail("budget_exceeded");
      else if (name === "list_records") {
        const offset = cursors.get(args.cursor);
        result =
          args.collection !== "ledger" || offset === undefined
            ? fail("invalid_collection_or_cursor")
            : {
                items: data.slice(offset, offset + SETTINGS.page_size),
                next_cursor: cursorAt.get(offset + SETTINGS.page_size) ?? null,
              };
      } else if (name === "submit_report") {
        let report;
        try {
          report = JSON.parse(args.json);
        } catch {
          result = fail("invalid_json");
        }
        if (!result) {
          await emit({ type: "pi_eval_submission", operation, report });
          result = { accepted: true };
        }
      } else result = fail("unavailable_in_ledger_task");
      return structuredClone(result);
    } finally {
      await emit({
        type: "pi_eval_service_end",
        operation,
        name,
        start_ms,
        end_ms: Date.now(),
        success: !!result && !result.error,
        error: result?.error?.code ?? null,
        response_bytes: result ? Buffer.byteLength(JSON.stringify(result)) : 0,
      });
    }
  }
  return {
    call(name, args, signal) {
      // Shared cap applies to the entire operation, not merely the reported count.
      const pending = tail.then(() => execute(name, args, signal));
      tail = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    },
  };
}
