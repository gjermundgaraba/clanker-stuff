import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { estimateModelVisibleTokens, shrinkTrailingOutputs } from "../replay.js";
import {
  assertCandidateWithinControlBounds,
  feasibilityCases,
} from "../scripts/live-compaction-feasibility-options.js";
import {
  assertFeasibilityUsage,
  createFeasibilityInput,
  installFeasibilityRequestBudget,
  requireCompactionResult,
  runFeasibility,
} from "../scripts/live-compaction-feasibility.js";

const COMPACTION_HEADERS = {
  "x-codex-beta-features": "remote_compaction_v2",
  "x-openai-internal-codex-responses-lite": "true",
};

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];

  constructor(
    readonly url: string,
    readonly options: { readonly headers: Readonly<Record<string, string>> },
  ) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }
}

const canaryCase = (id: ReturnType<typeof feasibilityCases>[number]["id"]) => {
  const found = feasibilityCases().find((candidate) => candidate.id === id);
  if (found === undefined) {
    throw new Error(`Missing feasibility case: ${id}`);
  }
  return found;
};

const compactionRecord = (index = 0, websocket = false) => ({
  client_metadata: {
    session_id: `fresh-session-${index}`,
    turn_id: `fresh-turn-${index}`,
    ws_request_header_x_openai_internal_codex_responses_lite: websocket ? "true" : undefined,
  },
  input: [{ type: "compaction_trigger" }],
  model: "gpt-5.6-sol",
  prompt_cache_key: `fresh-cache-key-${index}`,
  type: websocket ? "response.create" : undefined,
});

type CompactionRecord = ReturnType<typeof compactionRecord>;

const compactionBody = (index = 0, websocket = false) =>
  JSON.stringify(compactionRecord(index, websocket));

interface InvalidIdentityCase {
  readonly error: string;
  readonly name: string;
  readonly mutate: (request: CompactionRecord) => void;
}

const invalidIdentityCases = [
  {
    error: "request model did not match",
    name: "model",
    mutate: (request) => {
      request.model = "gpt-5.6-terra";
    },
  },
  {
    error: "prompt cache key is missing",
    name: "cache key",
    mutate: (request) => {
      request.prompt_cache_key = "";
    },
  },
  {
    error: "session metadata is missing",
    name: "session ID",
    mutate: (request) => {
      request.client_metadata.session_id = "";
    },
  },
  {
    error: "session metadata is missing",
    name: "turn ID",
    mutate: (request) => {
      request.client_metadata.turn_id = "";
    },
  },
] satisfies readonly InvalidIdentityCase[];

interface ReusedIdentityCase {
  readonly name: string;
  readonly reuse: (request: CompactionRecord, previous: CompactionRecord) => void;
}

const reusedIdentityCases = [
  {
    name: "cache key",
    reuse: (request, previous) => {
      request.prompt_cache_key = previous.prompt_cache_key;
    },
  },
  {
    name: "session ID",
    reuse: (request, previous) => {
      request.client_metadata.session_id = previous.client_metadata.session_id;
    },
  },
  {
    name: "turn ID",
    reuse: (request, previous) => {
      request.client_metadata.turn_id = previous.client_metadata.turn_id;
    },
  },
] satisfies readonly ReusedIdentityCase[];

const constructSocket = (url: string, headers: Record<string, string>) => {
  const socket: unknown = Reflect.construct(globalThis.WebSocket, [url, { headers }]);
  if (!(socket instanceof FakeWebSocket)) {
    throw new Error("Expected feasibility guard to construct the fake WebSocket");
  }
  return socket;
};

describe("live compaction feasibility request budget", () => {
  afterEach(() => {
    FakeWebSocket.instances = [];
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("preflights the 290000 example against a 272000/95% Sol control", () => {
    const candidate = createFeasibilityInput(290_000, "00000000-0000-4000-8000-000000000000");
    const control = shrinkTrailingOutputs(candidate, "", Math.floor(272_000 * 0.95));

    expect(() =>
      assertCandidateWithinControlBounds({
        candidateEstimatedTokens: estimateModelVisibleTokens("", candidate),
        candidateSerializedBytes: Buffer.byteLength(JSON.stringify(candidate), "utf-8"),
        controlEstimatedTokens: estimateModelVisibleTokens("", control),
        controlSerializedBytes: Buffer.byteLength(JSON.stringify(control), "utf-8"),
      }),
    ).not.toThrow();
  });

  it("uses Request headers and returns the original first SSE response", async () => {
    const response = new Response("provider-owned stream");
    const nativeFetch = vi.fn<typeof fetch>(async () => response);
    vi.stubGlobal("fetch", nativeFetch);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const budget = installFeasibilityRequestBudget();
    const abort = new AbortController();
    budget.begin(canaryCase("sol-sse-1"), "gpt-5.6-sol", abort);

    const request = new Request("https://example.test/codex/responses", {
      body: compactionBody(),
      headers: COMPACTION_HEADERS,
      method: "POST",
    });
    await expect(globalThis.fetch(request)).resolves.toBe(response);

    expect(nativeFetch).toHaveBeenCalledOnce();
    expect(abort.signal.aborted).toBeFalsy();
    expect(budget.requestCount).toBe(1);
    budget.restore();
  });

  it("rejects missing native headers before counting or SSE transport", async () => {
    const nativeFetch = vi.fn<typeof fetch>(async () => new Response());
    vi.stubGlobal("fetch", nativeFetch);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const budget = installFeasibilityRequestBudget();
    const abort = new AbortController();
    budget.begin(canaryCase("sol-sse-1"), "gpt-5.6-sol", abort);

    await expect(
      globalThis.fetch("https://example.test/codex/responses", {
        body: compactionBody(),
        headers: { "x-openai-internal-codex-responses-lite": "true" },
        method: "POST",
      }),
    ).rejects.toThrow("remote_compaction_v2");

    expect(nativeFetch).not.toHaveBeenCalled();
    expect(abort.signal.aborted).toBeTruthy();
    expect(budget.requestCount).toBe(0);
    budget.restore();
  });

  it.each(invalidIdentityCases)(
    "rejects an invalid $name before counting or SSE transport",
    async ({ error, mutate }) => {
      const nativeFetch = vi.fn<typeof fetch>(async () => new Response());
      vi.stubGlobal("fetch", nativeFetch);
      vi.stubGlobal("WebSocket", FakeWebSocket);
      const budget = installFeasibilityRequestBudget();
      const abort = new AbortController();
      budget.begin(canaryCase("sol-sse-1"), "gpt-5.6-sol", abort);
      const request = compactionRecord();
      mutate(request);

      await expect(
        globalThis.fetch("https://example.test/codex/responses", {
          body: JSON.stringify(request),
          headers: COMPACTION_HEADERS,
          method: "POST",
        }),
      ).rejects.toThrow(error);

      expect(nativeFetch).not.toHaveBeenCalled();
      expect(abort.signal.aborted).toBeTruthy();
      expect(budget.requestCount).toBe(0);
      budget.restore();
    },
  );

  it.each(reusedIdentityCases)(
    "rejects a reused $name before a second SSE transport",
    async ({ reuse }) => {
      const nativeFetch = vi.fn<typeof fetch>(async () => new Response());
      vi.stubGlobal("fetch", nativeFetch);
      vi.stubGlobal("WebSocket", FakeWebSocket);
      const budget = installFeasibilityRequestBudget();
      const sseCase = canaryCase("sol-sse-1");
      const previous = compactionRecord();
      budget.begin(sseCase, "gpt-5.6-sol", new AbortController());
      await globalThis.fetch("https://example.test/codex/responses", {
        body: JSON.stringify(previous),
        headers: COMPACTION_HEADERS,
        method: "POST",
      });
      budget.end();

      const abort = new AbortController();
      const request = compactionRecord(1);
      reuse(request, previous);
      budget.begin(sseCase, "gpt-5.6-sol", abort);
      await expect(
        globalThis.fetch("https://example.test/codex/responses", {
          body: JSON.stringify(request),
          headers: COMPACTION_HEADERS,
          method: "POST",
        }),
      ).rejects.toThrow("cache/session metadata was reused");

      expect(nativeFetch).toHaveBeenCalledOnce();
      expect(abort.signal.aborted).toBeTruthy();
      expect(budget.requestCount).toBe(1);
      budget.restore();
    },
  );

  it("blocks a second SSE attempt before native transport", async () => {
    const nativeFetch = vi.fn<typeof fetch>(async () => new Response());
    vi.stubGlobal("fetch", nativeFetch);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const budget = installFeasibilityRequestBudget();
    const abort = new AbortController();
    budget.begin(canaryCase("sol-sse-1"), "gpt-5.6-sol", abort);
    const request = {
      body: compactionBody(),
      headers: COMPACTION_HEADERS,
      method: "POST",
    };

    await expect(
      globalThis.fetch("https://example.test/codex/responses", request),
    ).resolves.toBeInstanceOf(Response);
    await expect(globalThis.fetch("https://example.test/codex/responses", request)).rejects.toThrow(
      "a retry was blocked",
    );

    expect(nativeFetch).toHaveBeenCalledOnce();
    expect(abort.signal.aborted).toBeTruthy();
    expect(budget.requestCount).toBe(1);
    budget.restore();
  });

  it("blocks a sixth distinct compaction request before native transport", async () => {
    const nativeFetch = vi.fn<typeof fetch>(async () => new Response());
    vi.stubGlobal("fetch", nativeFetch);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const budget = installFeasibilityRequestBudget();
    const sseCase = canaryCase("control");

    for (let index = 0; index < 5; index += 1) {
      const abort = new AbortController();
      budget.begin(sseCase, "gpt-5.6-sol", abort);
      await globalThis.fetch("https://example.test/codex/responses", {
        body: compactionBody(index),
        headers: COMPACTION_HEADERS,
        method: "POST",
      });
      budget.end();
    }

    const sixthAbort = new AbortController();
    budget.begin(sseCase, "gpt-5.6-sol", sixthAbort);
    await expect(
      globalThis.fetch("https://example.test/codex/responses", {
        body: compactionBody(5),
        headers: COMPACTION_HEADERS,
        method: "POST",
      }),
    ).rejects.toThrow("Compaction request budget exceeded 5");
    expect(nativeFetch).toHaveBeenCalledTimes(5);
    expect(sixthAbort.signal.aborted).toBeTruthy();
    expect(budget.requestCount).toBe(5);
    budget.restore();
  });

  it("rejects invalid WebSocket handshakes before native construction", () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>());
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
    const budget = installFeasibilityRequestBudget();
    const abort = new AbortController();
    budget.begin(canaryCase("sol-ws"), "gpt-5.6-sol", abort);

    expect(() =>
      constructSocket("wss://example.test/codex/responses", {
        "x-openai-internal-codex-responses-lite": "true",
      }),
    ).toThrow("remote_compaction_v2");

    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(abort.signal.aborted).toBeTruthy();
    budget.restore();
    expect(Object.getOwnPropertyDescriptor(globalThis, "WebSocket")).toStrictEqual(
      originalDescriptor,
    );
  });

  it("rejects invalid WebSocket endpoints before native construction", () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>());
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const budget = installFeasibilityRequestBudget();
    const abort = new AbortController();
    budget.begin(canaryCase("sol-ws"), "gpt-5.6-sol", abort);

    expect(() => constructSocket("wss://example.test/not-responses", COMPACTION_HEADERS)).toThrow(
      "unexpected websocket endpoint",
    );

    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(abort.signal.aborted).toBeTruthy();
    budget.restore();
  });

  it("blocks a second WebSocket construction before native transport", () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>());
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const budget = installFeasibilityRequestBudget();
    const abort = new AbortController();
    budget.begin(canaryCase("sol-ws"), "gpt-5.6-sol", abort);

    constructSocket("wss://example.test/codex/responses", COMPACTION_HEADERS);
    expect(() => constructSocket("wss://example.test/codex/responses", COMPACTION_HEADERS)).toThrow(
      "WebSocket retry was blocked",
    );

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(abort.signal.aborted).toBeTruthy();
    budget.restore();
  });

  it("validates WebSocket compaction frames before native send", () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>());
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const budget = installFeasibilityRequestBudget();
    const abort = new AbortController();
    budget.begin(canaryCase("sol-ws"), "gpt-5.6-sol", abort);
    const socket = constructSocket("wss://example.test/codex/responses", COMPACTION_HEADERS);

    expect(() => socket.send(JSON.stringify({ input: [], type: "response.create" }))).toThrow(
      "non-compaction WebSocket request blocked",
    );

    expect(socket.sent).toHaveLength(0);
    expect(budget.requestCount).toBe(0);
    expect(abort.signal.aborted).toBeTruthy();
    budget.restore();
  });

  it("blocks a second WebSocket compaction frame before native send", () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>());
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const budget = installFeasibilityRequestBudget();
    const abort = new AbortController();
    budget.begin(canaryCase("sol-ws"), "gpt-5.6-sol", abort);
    const socket = constructSocket("wss://example.test/codex/responses", COMPACTION_HEADERS);
    const frame = compactionBody(0, true);

    socket.send(frame);
    expect(() => socket.send(frame)).toThrow("a retry was blocked");

    expect(socket.sent).toHaveLength(1);
    expect(budget.requestCount).toBe(1);
    expect(abort.signal.aborted).toBeTruthy();
    budget.restore();
  });

  it("surfaces the outer provider error when compaction produced no result", () => {
    expect(() =>
      requireCompactionResult("control", undefined, {
        errorMessage: "backend rejected compaction",
        stopReason: "error",
      }),
    ).toThrow("control: backend rejected compaction");
  });

  it("rejects every post-response usage stop condition", () => {
    const candidate = canaryCase("sol-sse-1");
    expect(() =>
      assertFeasibilityUsage(candidate, {
        cacheRead: 1,
        cacheWrite: 0,
        input: 282_952,
      }),
    ).toThrow("unexpectedly read cached tokens");
    expect(() =>
      assertFeasibilityUsage(candidate, {
        cacheRead: 0,
        cacheWrite: 0,
        input: 325_001,
      }),
    ).toThrow("exceeded the per-case stop limit");
    expect(() =>
      assertFeasibilityUsage(candidate, {
        cacheRead: 0,
        cacheWrite: 0,
        input: 282_952,
      }),
    ).toThrow("did not exceed the observed");
  });

  it("shows leading-separator help without touching credentials or the network", async () => {
    const credentialAccess = vi
      .spyOn(ModelRuntime, "create")
      .mockRejectedValue(new Error("credential access is poisoned"));
    const networkAccess = vi.fn<typeof fetch>(async () => {
      throw new Error("network access is poisoned");
    });
    const log = vi.spyOn(console, "log").mockReturnValue();
    vi.stubGlobal("fetch", networkAccess);

    await expect(runFeasibility(["--", "--help"], {})).resolves.toBeUndefined();

    expect(credentialAccess).not.toHaveBeenCalled();
    expect(networkAccess).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("--candidate-tokens 290000"));
  });
});
