// The entrypoint's event wiring: summary operations and history rewrites.

import type {
  SessionBeforeCompactEvent,
  SessionBeforeTreeEvent,
  SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import claudeBridge from "../index.js";
import { summarySessionFor } from "../session/cwd.js";
import { shared } from "../shared.js";

const SESSION_ID = "pi-session";

afterEach(() => {
  const state = shared();

  state.activeStream = undefined;
  state.markRebuildHooks.clear();
});

describe("summary operations", () => {
  // The handlers only see the event's signal; the rest of the event is pi's business.
  it.each(["session_before_compact", "session_before_tree"] as const)(
    "%s leaves the summary to pi and other extensions, in the session's cwd",
    async (type) => {
      const host = createExtensionHost(claudeBridge, { sessionId: SESSION_ID });
      const signal = new AbortController().signal;

      const event = { type, signal } satisfies Pick<
        SessionBeforeCompactEvent | SessionBeforeTreeEvent,
        "type" | "signal"
      >;

      // Any result would cancel the operation or replace pi's summarizer.
      expect(await host.emit(type, event)).toEqual([undefined]);
      // pi forwards this signal to the summary calls, which run in this session's cwd.
      expect(summarySessionFor(signal)).toBe(SESSION_ID);
    },
  );
});

describe("history rewrites", () => {
  /** Every rewrite forwarded to the evaluations in this process. */
  function observeRewrites(): [string | null, string][] {
    const seen: [string | null, string][] = [];

    shared().markRebuildHooks.add((piSession, event) => {
      seen.push([piSession, event]);
    });

    return seen;
  }

  it("forwards a compaction of the session to every evaluation", async () => {
    const host = createExtensionHost(claudeBridge, { sessionId: SESSION_ID });

    await host.ready;

    const seen = observeRewrites();

    const event: SessionCompactEvent = {
      type: "session_compact",
      compactionEntry: {
        type: "compaction",
        id: "compaction-1",
        parentId: null,
        timestamp: new Date(0).toISOString(),
        summary: "summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 1000,
      },
      fromExtension: false,
      reason: "overflow",
      willRetry: true,
    };

    await host.emit("session_compact", event);

    expect(seen).toEqual([[SESSION_ID, "session_compact:overflow:willRetry=true"]]);
  });

  it("forwards a tree navigation of the session to every evaluation", async () => {
    const host = createExtensionHost(claudeBridge, { sessionId: SESSION_ID });

    await host.ready;

    const seen = observeRewrites();

    await host.emitSessionTree();

    expect(seen).toEqual([[SESSION_ID, "session_tree"]]);
  });
});
