export interface EvaluationTask {
  readonly files: Readonly<Record<string, string>>;
  readonly hiddenTest: string;
  readonly id: string;
  readonly long?: boolean;
  readonly prompts: readonly string[];
  readonly protectedFiles: readonly string[];
  readonly requiresExtensionCompaction?: boolean;
  readonly solution: Readonly<Record<string, string>>;
}

const packageJson = (name: string) =>
  `${JSON.stringify(
    { name, private: true, scripts: { test: "node --test" }, type: "module" },
    null,
    2,
  )}\n`;

const inventorySpec = `# Inventory ledger

Implement the exports in src/ledger.js.

- parseEvents reads newline-delimited JSON, ignoring blank lines and comments whose first non-space character is #.
- Malformed JSON throws SyntaxError with a message beginning "line N:" (physical line number).
- Events are objects with type receive, ship, or adjust; a non-empty SKU normalized with trim().toUpperCase(); and an integer quantity. Receive/ship quantities are positive; adjust is non-negative.
- applyEvents returns a Map. Receive adds, ship subtracts, and adjust replaces. Shipping below zero throws RangeError mentioning the SKU and source line.
`;

const inventorySource = `export function parseEvents(input) {
  return input.trim().split("\\n").map((line, index) => ({
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
`;

const inventorySolution = `const lineError = (ErrorType, line, message) =>
  new ErrorType(\`line \${line}: \${message}\`);

export function parseEvents(input) {
  const events = [];
  for (const [index, source] of input.split("\\n").entries()) {
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
    const sku = typeof event.sku === "string" ? event.sku.trim().toUpperCase() : "";
    const validType = ["receive", "ship", "adjust"].includes(event.type);
    const validQuantity = Number.isInteger(event.quantity) &&
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
    const next = event.type === "adjust"
      ? event.quantity
      : current + (event.type === "receive" ? event.quantity : -event.quantity);
    if (next < 0) throw new RangeError(\`\${event.sku} below zero at line \${event.line}\`);
    stock.set(event.sku, next);
  }
  return stock;
}
`;

const inventoryPublicTest = `import assert from "node:assert/strict";
import test from "node:test";
import { applyEvents, parseEvents } from "../src/ledger.js";

test("parses and applies normal events", () => {
  const events = parseEvents('# seed\\n{"type":"receive","sku":" a ","quantity":5}\\n\\n{"type":"ship","sku":"A","quantity":2}');
  assert.deepEqual(events, [
    { type: "receive", sku: "A", quantity: 5, line: 2 },
    { type: "ship", sku: "A", quantity: 2, line: 4 },
  ]);
  assert.equal(applyEvents(events).get("A"), 3);
});
`;

const inventoryHiddenTest = `import assert from "node:assert/strict";
import test from "node:test";
import { applyEvents, parseEvents } from "../src/ledger.js";

test("handles empty input, adjustment, and physical error lines", () => {
  assert.deepEqual(parseEvents("  \\n # none\\n"), []);
  assert.equal(applyEvents(parseEvents('{"type":"adjust","sku":"x","quantity":0}')).get("X"), 0);
  assert.throws(() => parseEvents('# x\\n\\n{"type":'), { name: "SyntaxError", message: /^line 3:/ });
});

test("rejects invalid events and negative stock", () => {
  for (const source of ["null", '{"type":"ship","sku":"x","quantity":0}', '{"type":"wat","sku":"x","quantity":1}', '{"type":"adjust","sku":" ","quantity":1}']) {
    assert.throws(() => parseEvents(source), { message: /^line 1:/ });
  }
  assert.throws(
    () => applyEvents([{ type: "ship", sku: "X", quantity: 1, line: 9 }]),
    { name: "RangeError", message: /X.*9|9.*X/ }
  );
});
`;

const retrySpec = `# Retry helper

Fix src/retry.js without adding dependencies.

- parseRetryAfter(value, nowMs) returns a non-negative delay in milliseconds for either delta-seconds or an HTTP-date. Invalid, negative, or missing values return null.
- requestWithRetry(fetcher, url, options) retries only 429 and 503 responses, up to maxAttempts total (default 3).
- Before a retry, use Retry-After when valid, otherwise baseDelayMs * 2 ** (attempt - 1). Default baseDelayMs is 100.
- options.sleep and options.now are injectable functions; defaults use setTimeout and Date.now.
- Return the first non-retryable response or the last response after exhausting attempts. Propagate fetch and sleep errors.
`;

const retrySource = `export function parseRetryAfter(value, nowMs) {
  return Number(value) * 1000;
}

export async function requestWithRetry(fetcher, url, options = {}) {
  return fetcher(url);
}
`;

const retrySolution = `export function parseRetryAfter(value, nowMs) {
  if (typeof value !== "string" || !value.trim()) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : null;
  const date = Date.parse(value);
  return Number.isNaN(date) || date < nowMs ? null : date - nowMs;
}

export async function requestWithRetry(fetcher, url, options = {}) {
  const {
    baseDelayMs = 100,
    maxAttempts = 3,
    now = Date.now,
    sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
  } = options;
  let response;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    response = await fetcher(url);
    if (![429, 503].includes(response.status) || attempt === maxAttempts) return response;
    const retryAfter = parseRetryAfter(response.headers.get("retry-after"), now());
    await sleep(retryAfter ?? baseDelayMs * 2 ** (attempt - 1));
  }
  return response;
}
`;

const retryPublicTest = `import assert from "node:assert/strict";
import test from "node:test";
import { parseRetryAfter, requestWithRetry } from "../src/retry.js";

test("parses seconds and retries a 503", async () => {
  assert.equal(parseRetryAfter("1.5", 0), 1500);
  const statuses = [503, 200];
  const delays = [];
  const response = await requestWithRetry(
    async () => ({ status: statuses.shift(), headers: new Headers() }),
    "https://example.invalid",
    { sleep: async (delay) => delays.push(delay) }
  );
  assert.equal(response.status, 200);
  assert.deepEqual(delays, [100]);
});
`;

const retryHiddenTest = `import assert from "node:assert/strict";
import test from "node:test";
import { parseRetryAfter, requestWithRetry } from "../src/retry.js";

test("parses dates and rejects invalid delays", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(parseRetryAfter("Thu, 01 Jan 2026 00:00:02 GMT", now), 2000);
  for (const value of [undefined, "", "-1", "not-a-date"]) assert.equal(parseRetryAfter(value, now), null);
});

test("uses retry-after then exponential fallback and stops", async () => {
  const delays = [];
  let calls = 0;
  const response = await requestWithRetry(
    async () => {
      calls += 1;
      return { status: 429, headers: new Headers(calls === 1 ? { "retry-after": "2" } : {}) };
    },
    "https://example.invalid",
    { baseDelayMs: 7, maxAttempts: 3, now: () => 0, sleep: async (delay) => delays.push(delay) }
  );
  assert.equal(response.status, 429);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [2000, 14]);
});

test("does not retry other statuses", async () => {
  let calls = 0;
  await requestWithRetry(async () => {
    calls += 1;
    return { status: 500, headers: new Headers() };
  }, "x", { sleep: async () => assert.fail("should not sleep") });
  assert.equal(calls, 1);
});
`;

const releaseSource = `export function normalizeRelease(config) {
  return { ...config };
}
`;

const releaseSolution = `const REGION_ORDER = ["us", "eu", "apac"];

export function normalizeRelease(config) {
  const channel = config.channel.trim().toLowerCase();
  if (!["stable", "beta", "canary"].includes(channel)) throw new TypeError("invalid channel");
  const rolloutPercent = config.rolloutPercent === undefined ? 100 : Number(config.rolloutPercent);
  if (!Number.isInteger(rolloutPercent) || rolloutPercent < 0 || rolloutPercent > 100) {
    throw new TypeError("invalid rolloutPercent");
  }
  const seen = new Set();
  const artifacts = config.artifacts.map((value) => value.trim()).filter((value) => {
    const key = value.toLowerCase();
    if (!value || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const regions = [...config.regions].map((value) => value.trim().toLowerCase());
  regions.sort((a, b) => REGION_ORDER.indexOf(a) - REGION_ORDER.indexOf(b));
  return { artifacts, channel, regions, rolloutPercent };
}
`;

const releasePublicTest = `import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRelease } from "../src/release.js";

test("normalizes a basic release", () => {
  assert.deepEqual(normalizeRelease({
    artifacts: ["app.zip"], channel: " STABLE ", regions: ["eu", "us"]
  }), {
    artifacts: ["app.zip"], channel: "stable", regions: ["us", "eu"], rolloutPercent: 100
  });
});
`;

const releaseHiddenTest = `import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRelease } from "../src/release.js";

test("applies all accumulated release decisions", () => {
  assert.deepEqual(normalizeRelease({
    artifacts: [" App.zip ", "app.ZIP", "symbols.tgz", ""],
    channel: " BETA ", regions: ["APAC", " us ", "eu"], rolloutPercent: "25"
  }), {
    artifacts: ["App.zip", "symbols.tgz"], channel: "beta",
    regions: ["us", "eu", "apac"], rolloutPercent: 25
  });
});

test("validates channel and rollout", () => {
  assert.throws(() => normalizeRelease({ artifacts: [], channel: "edge", regions: [] }), TypeError);
  for (const rolloutPercent of [-1, 101, 1.5, "nope"]) {
    assert.throws(() => normalizeRelease({ artifacts: [], channel: "stable", regions: [], rolloutPercent }), TypeError);
  }
});
`;

const continuityFiller = "audit datum\n".repeat(20_000);
const continuityPrompts = [
  ...[
    "Normalize channel with trim().toLowerCase() and accept only stable, beta, or canary.",
    "Deduplicate artifacts case-insensitively after trimming, preserving the first spelling and dropping empty names.",
    "rolloutPercent defaults to 100; coerce with Number and require an integer from 0 through 100.",
    "Normalize regions with trim().toLowerCase() and sort them in us, eu, apac order.",
    "Return exactly artifacts, channel, regions, and rolloutPercent. Invalid channel or rollout throws TypeError.",
  ].map(
    (decision, index) =>
      `Release review phase ${index + 1}/5. Remember this decision for the final implementation: ${decision}\nDo not edit files yet. Reply only with PHASE-${index + 1}-RECORDED.\n\n${continuityFiller}`,
  ),
  "Resume the release review. Implement every decision from phases 1 through 5 in src/release.js, then run the tests. Do not ask me to restate them and do not add dependencies.",
];

export const evaluationTasks: readonly EvaluationTask[] = [
  {
    files: {
      "SPEC.md": inventorySpec,
      "package.json": packageJson("inventory-ledger-eval"),
      "src/ledger.js": inventorySource,
      "test/ledger.test.js": inventoryPublicTest,
    },
    hiddenTest: inventoryHiddenTest,
    id: "inventory-ledger",
    prompts: [
      "Implement SPEC.md, make the minimum correct changes, and run the tests. Do not modify SPEC.md or existing tests, add dependencies, or commit.",
    ],
    protectedFiles: ["SPEC.md", "test/ledger.test.js"],
    solution: { "src/ledger.js": inventorySolution },
  },
  {
    files: {
      "SPEC.md": retrySpec,
      "package.json": packageJson("http-retry-eval"),
      "src/retry.js": retrySource,
      "test/retry.test.js": retryPublicTest,
    },
    hiddenTest: retryHiddenTest,
    id: "http-retry",
    prompts: [
      "Fix the retry helper described in SPEC.md and run the tests. Do not modify SPEC.md or existing tests, add dependencies, or commit.",
    ],
    protectedFiles: ["SPEC.md", "test/retry.test.js"],
    solution: { "src/retry.js": retrySolution },
  },
  {
    files: {
      "package.json": packageJson("compaction-resume-eval"),
      "src/release.js": releaseSource,
      "test/release.test.js": releasePublicTest,
    },
    hiddenTest: releaseHiddenTest,
    id: "compaction-resume",
    long: true,
    prompts: continuityPrompts,
    protectedFiles: ["test/release.test.js"],
    requiresExtensionCompaction: true,
    solution: { "src/release.js": releaseSolution },
  },
];
