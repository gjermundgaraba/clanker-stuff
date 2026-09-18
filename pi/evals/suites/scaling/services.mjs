import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

export const SERVICE_NAMES = ["list_records", "submit_report"];

/**
 * @typedef {[name: string, description: string, parameters: import("typebox").TSchema]} ToolSpec
 * @param {typeof import("typebox").Type} Type
 * @returns {ToolSpec[]}
 */
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

/** @type {unknown} */
const settings = JSON.parse(readFileSync(new URL("./case.json", import.meta.url), "utf8"));

/** @param {unknown} value @returns {value is Record<string, unknown>} */
// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Generated case files and service calls are independent JSON boundaries; this JSDoc predicate excludes null and arrays.
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

// The task generator owns these required seed and sizing settings. Fail before creating a ledger or cursor loop.
/* oxlint-disable anti-slop/no-runtime-typeof -- Validate the complete generated case contract; the standalone service has no runtime schema dependency. */
if (
  !isRecord(settings) ||
  typeof settings.count !== "number" ||
  !Number.isSafeInteger(settings.count) ||
  settings.count < 7 ||
  typeof settings.seed !== "string" ||
  settings.seed.length === 0 ||
  typeof settings.page_size !== "number" ||
  !Number.isSafeInteger(settings.page_size) ||
  settings.page_size < 1 ||
  typeof settings.budget !== "number" ||
  !Number.isSafeInteger(settings.budget) ||
  settings.budget < 1
) {
  throw new TypeError("Invalid scaling case settings");
}
/* oxlint-enable anti-slop/no-runtime-typeof */

export const SETTINGS = {
  count: settings.count,
  seed: settings.seed,
  page_size: settings.page_size,
  budget: settings.budget,
};

export const FIXTURE = `scaling-ledger-${SETTINGS.count}-${SETTINGS.seed}-v1`;

/** @param {string} s */
const hash = (s) => createHash("sha256").update(s).digest("hex");

export function fixture() {
  return {
    ledger: Array.from({ length: SETTINGS.count }, (_, i) => {
      const d = createHash("sha256").update(`${SETTINGS.seed}:row:${i}`).digest();

      return {
        id: `entry-${hash(`${SETTINGS.seed}:${i}`).slice(0, 14)}`,
        tenant: `tenant-${i < 7 ? i : d.readUInt8(0) % 7}`,
        status: i < 7 || d.readUInt8(1) % 5 !== 0 ? "posted" : "pending",
        currency: i < 7 || d.readUInt8(2) % 11 !== 0 ? "USD" : "EUR",
        day: i < 7 ? 10 : 1 + (d.readUInt8(3) % 31),
        amount_cents: 1000 + (d.readUInt32LE(4) % 20000),
        refund_cents: d.readUInt8(8) % 9 === 0 ? d.readUInt16LE(9) % 1500 : 0,
        archived_note: "archived ".repeat(20),
      };
    }),
  };
}

/**
 * @typedef {ReturnType<typeof fixture>["ledger"][number]} LedgerEntry
 * @typedef {{error: {code: string, retryable: boolean}}} ServiceFailure
 * @typedef {{items: LedgerEntry[], next_cursor: string|null} | {accepted: boolean} | ServiceFailure} ServiceResult
 * @typedef {{type: "pi_eval_service_start", operation: number, name: string, args: unknown, start_ms: number, concurrent: number}} ServiceStart
 * @typedef {{type: "pi_eval_service_end", operation: number, name: string, start_ms: number, end_ms: number, success: boolean, error: string|null, response_bytes: number}} ServiceEnd
 * @typedef {{type: "pi_eval_submission", operation: number, report: unknown}} Submission
 * @typedef {ServiceStart | ServiceEnd | Submission} ServiceEvent
 * @param {{emit?: (event: ServiceEvent)=>void|Promise<void>,latencyMs?:number}} options
 */
export function createServices({ emit = () => {}, latencyMs = 150 } = {}) {
  const data = fixture().ledger;
  /** @type {Map<string|null, number>} */
  const cursors = new Map([[null, 0]]);

  for (let n = SETTINGS.page_size; n < data.length; n += SETTINGS.page_size)
    cursors.set(`cursor-${hash(`${SETTINGS.seed}:cursor:${n}`).slice(0, 20)}`, n);
  const cursorAt = new Map([...cursors].map(([c, n]) => [n, c]));

  let sequence = 0,
    tail = Promise.resolve();

  /** @param {string} code @returns {ServiceFailure} */
  const fail = (code) => ({ error: { code, retryable: false } });

  /** @param {string} name @param {unknown} args @param {AbortSignal|undefined} signal */
  async function execute(name, args, signal) {
    const operation = ++sequence,
      start_ms = Date.now();

    await emit({ type: "pi_eval_service_start", operation, name, args, start_ms, concurrent: 1 });
    /** @type {ServiceResult|undefined} */
    let result;

    try {
      await delay(latencyMs, undefined, { signal });

      if (operation > SETTINGS.budget && name !== "submit_report") result = fail("budget_exceeded");
      else if (name === "list_records") {
        const offset =
          isRecord(args) &&
          args.collection === "ledger" &&
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- This callable backend also serves the reference solver directly; validate the complete list request before cursor lookup.
          (args.cursor === null || typeof args.cursor === "string")
            ? cursors.get(args.cursor)
            : undefined;

        result =
          offset === undefined
            ? fail("invalid_collection_or_cursor")
            : {
                items: data.slice(offset, offset + SETTINGS.page_size),
                next_cursor: cursorAt.get(offset + SETTINGS.page_size) ?? null,
              };
      } else if (name === "submit_report") {
        /** @type {unknown} */
        let report;

        try {
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- A submission must contain JSON text; its parsed report stays unknown for the grader to judge, including malformed task answers.
          if (!isRecord(args) || typeof args.json !== "string")
            throw new TypeError("Missing report JSON");
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
        success: !!result && !("error" in result),
        error: result && "error" in result ? result.error.code : null,
        response_bytes: result ? Buffer.byteLength(JSON.stringify(result)) : 0,
      });
    }
  }

  return {
    /** @param {string} name @param {unknown} args Raw service arguments, validated by the independently callable backend. @param {AbortSignal} [signal] */
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
