import { describe, expect, it } from "vite-plus/test";
import { sanitizeTraceInput } from "../../code-mode/trace-values.js";
import { wireRecord } from "../fixtures.js";

describe("Code Mode trace values", () => {
  it("contains hostile trace values", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("hostile ownKeys");
        },
      },
    );

    expect(sanitizeTraceInput(hostile, 100)).toBe("[unavailable object]");
  });

  it("contains hostile object getters, array accessors, and revoked proxies", () => {
    const hostileGetter = {
      get value() {
        throw new Error("hostile getter");
      },
    };

    const hostileArray = new Proxy([1], {
      get: () => {
        throw new Error("hostile array accessor");
      },
    });

    const revoked = Proxy.revocable({}, {});
    revoked.revoke();

    for (const value of [hostileGetter, hostileArray, revoked.proxy]) {
      expect(sanitizeTraceInput(value, 100)).toBe("[unavailable object]");
    }
  });

  it.each([NaN, Infinity, -Infinity])("normalizes non-finite %s to JSON null", (value) => {
    expect(sanitizeTraceInput(value, 100)).toBeNull();
  });

  it("uses detached JSON semantics for diagnostic snapshots", () => {
    expect(sanitizeTraceInput([null, undefined, true, -0, 1.5], 100)).toStrictEqual([
      null,
      null,
      true,
      0,
      1.5,
    ]);
    expect(sanitizeTraceInput({ absent: undefined, big: 1n }, 100)).toStrictEqual({});
    expect(sanitizeTraceInput([1n, Symbol("test")], 100)).toStrictEqual([null, null]);
    expect(sanitizeTraceInput(new Date("2026-01-01"), 100)).toBe("2026-01-01T00:00:00.000Z");
    expect(sanitizeTraceInput(new Date(NaN), 100)).toBeNull();
    const input = { path: "file.ts", nested: { count: 1 } };
    const snapshot = sanitizeTraceInput(input, 1000);
    input.nested.count = 2;
    expect(snapshot).toStrictEqual({ path: "file.ts", nested: { count: 1 } });
    const shared = { count: 1 };
    expect(sanitizeTraceInput([shared, shared], 100)).toStrictEqual([shared, shared]);
    const circular: unknown[] = [];
    circular.push(circular);
    expect(sanitizeTraceInput(circular, 100)).toStrictEqual(["[circular]"]);
  });

  it("preserves complete strings and structures that fit the serialized budget", () => {
    const command = "x".repeat(9000);
    expect(sanitizeTraceInput(command, 16384)).toBe(command);
    expect(sanitizeTraceInput({ cmd: command }, 16384)).toEqual({ cmd: command });

    for (const value of [
      command,
      { cmd: command },
      ["a", "b", "c", "d"],
      { nested: { 'escaped"key': "\u0000\n".repeat(50) } },
      { empty: "" },
    ]) {
      expect(sanitizeTraceInput(value, JSON.stringify(value).length)).toEqual(value);
    }

    expect(sanitizeTraceInput({ ignored: undefined, value: "a" }, 13)).toEqual({ value: "a" });
  });

  it("retains near-budget commands instead of discarding their objects", () => {
    for (const input of [
      { cmd: "x".repeat(16376) },
      { cmd: "x".repeat(16000), n: Array.from({ length: 34 }, () => 1234567890) },
      { cmd: "x".repeat(100_000) },
    ]) {
      const result = sanitizeTraceInput(input, 16384);
      expect(result).toHaveProperty("cmd", expect.stringMatching(/\[value truncated\]$/));
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(16384);
    }
  });

  it("shortens multiple strings deterministically without retry exhaustion", () => {
    const input = {
      first: "a".repeat(100),
      second: "b".repeat(100),
      third: "c".repeat(100),
      kind: "patch",
    };

    const result = sanitizeTraceInput(input, 110);
    expect(result).toEqual(sanitizeTraceInput(input, 110));
    expect(result).toMatchObject({
      first: "[value truncated]",
      second: "[value truncated]",
      kind: "patch",
    });
    expect(result).toHaveProperty("third", expect.stringMatching(/\[value truncated\]$/));
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(110);

    // The allocation guard clips bodies rather than rejecting the whole value.
    const many = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [index, "x".repeat(100_000)]),
    );

    const snapshot = sanitizeTraceInput(many, 16384);
    expect(snapshot).not.toBe("[value limit]");
    expect(JSON.stringify(snapshot).length).toBeLessThanOrEqual(16384);
  });

  it("accounts for escaping and never splits surrogate pairs while shortening", () => {
    for (const text of ["😀".repeat(100), "\u0000".repeat(100), '"\\'.repeat(100)]) {
      for (const budget of [29, 30, 31, 100]) {
        const result = sanitizeTraceInput(text, budget);
        expect(typeof result).toBe("string");

        if (typeof result !== "string") throw new Error("Expected a string snapshot");
        expect(result.endsWith("[value truncated]")).toBe(true);
        expect(result.isWellFormed()).toBe(true);
        expect(JSON.stringify(result).length).toBeLessThanOrEqual(budget);
      }
    }
  });

  it("evaluates arbitrary hooks only once even when a snapshot needs reduction", () => {
    let projections = 0;
    let reads = 0;

    const input = {
      toJSON() {
        projections += 1;

        return {
          get cmd() {
            reads += 1;

            return "x".repeat(100_000);
          },
        };
      },
    };

    expect(sanitizeTraceInput(input, 100)).toHaveProperty(
      "cmd",
      expect.stringMatching(/\[value truncated\]$/),
    );
    expect(projections).toBe(1);
    expect(reads).toBe(1);
  });

  it("marks cut strings and falls back for exhausted whole-value budgets", () => {
    expect(sanitizeTraceInput("text", 0)).toBe("[value limit]");
    expect(sanitizeTraceInput("a".repeat(100), 30)).toBe("a".repeat(11) + "[value truncated]");
    expect(sanitizeTraceInput([1, 2], 2)).toBe("[value limit]");
    expect(sanitizeTraceInput({ first: 1, second: 2 }, 2)).toBe("[value limit]");
    expect(
      sanitizeTraceInput(
        Array.from({ length: 4097 }, () => null),
        100_000,
      ),
    ).toBe("[value limit]");
    expect(sanitizeTraceInput({ ["k".repeat(1000)]: 1 }, 100)).toBe("[value limit]");
    expect(sanitizeTraceInput("\u0000".repeat(1000), 100)).toBe(
      "\u0000".repeat(13) + "[value truncated]",
    );
    const input = { patch: "*** Begin Patch\n" + "x".repeat(1000) };
    const result = sanitizeTraceInput(input, 100);
    expect(Object.keys(wireRecord(result))).toEqual(["patch"]);
    expect(result).toHaveProperty("patch", expect.stringMatching(/\[value truncated\]$/));
  });

  it("bounds depth and stops visiting siblings on node exhaustion", () => {
    let deep: unknown[] = [];

    for (let i = 0; i < 13; i += 1) deep = [deep];
    expect(JSON.stringify(sanitizeTraceInput(deep, 1000))).toContain("[Array]");
    let visits = 0;

    const leaf = {
      get value() {
        visits += 1;

        return null;
      },
    };

    const input = Array.from({ length: 4096 }, () => leaf);
    expect(sanitizeTraceInput(input, 100_000)).toBe("[value limit]");
    expect(visits).toBeLessThanOrEqual(2048);
  });

  it("contains nested failures and explicitly honors toJSON", () => {
    expect(
      sanitizeTraceInput(
        {
          good: 1,
          bad: {
            get value() {
              throw new Error("hostile");
            },
          },
        },
        100,
      ),
    ).toBe("[unavailable object]");
    expect(sanitizeTraceInput({ toJSON: () => ({ value: "projected" }) }, 100)).toStrictEqual({
      value: "projected",
    });
    expect(
      sanitizeTraceInput(
        {
          toJSON: () => {
            throw new Error("hostile");
          },
        },
        100,
      ),
    ).toBe("[unavailable object]");
    let calls = 0;

    const input = {
      toJSON: () => {
        calls += 1;

        return null;
      },
    };

    expect(sanitizeTraceInput(input, 0)).toBe("[value limit]");
    expect(calls).toBe(0);
  });
});
