// The bridge's runtime state: one per extension evaluation, so a subagent host that
// loads the extension fresh gets clean state, exactly as separate module instances did.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { safeText } from "@clanker-stuff/pi-tool-rendering/text";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import type { BridgeQuery, QueryFunction } from "./child.js";
import { debug } from "./log.js";
import { QueryContext } from "./query/context.js";
import type { McpResult } from "./query/tool-results.js";
import { SessionMirrors } from "./session/mirror.js";

type NotifyLevel = Parameters<ExtensionUIContext["notify"]>[1];

export class Bridge {
  readonly mirrors = new SessionMirrors((message) => this.notify(message, "warning"));

  /** Contexts with a live query. Tool results route only to these. */
  readonly activeQueries = new Set<QueryContext>();

  /** Queries pi's history moved out from under. Their completion must not touch the
   *  mirror or the pi stream: the query that took over the turn already rebuilt both. */
  readonly abandonedQueries = new WeakSet<BridgeQuery>();

  /** The context top-level (non-reentrant) queries reuse. */
  readonly topLevel = new QueryContext();

  private ui: ExtensionUIContext | undefined;

  /** Each pi tool's prompt guidelines by name, appended to its MCP description. */
  toolGuidelines: () => ReadonlyMap<string, readonly string[]> = () => new Map();

  constructor(readonly runQuery: QueryFunction = query) {}

  attachUi(ui: ExtensionUIContext): void {
    this.ui = ui;
  }

  /** Provider and Claude Code text reaches the terminal only sanitized. */
  notify(message: string, level: NotifyLevel = "warning"): void {
    this.ui?.notify(safeText(message), level);
  }

  /** pi replaced (rather than appended to) one session's history: its next sync must
   *  rebuild, and a query parked at a tool boundary on it must be discarded rather than
   *  resumed. Arming parked contexts cannot wait for delivery, because a rewrite usually
   *  lands while the query is parked (compaction runs inside pi's turn loop). */
  markRebuild(piSession: string | null, event: string): void {
    const state = this.mirrors.markRebuild(piSession);

    debug(
      state === undefined
        ? `${event}: history rewritten, no session to mark yet`
        : `${event}: marking needsRebuild on session ${state.sessionId.slice(0, 8)}`,
    );

    if (piSession !== null) this.mirrors.rewritten.add(piSession);

    this.armStaleContexts();
  }

  /** Copy each armed session's mark onto the parked queries built from it. */
  armStaleContexts(): void {
    for (const c of this.activeQueries) {
      if (c.piSessionId !== null && this.mirrors.rewritten.has(c.piSessionId)) {
        c.historyStale = true;
      }
    }
  }

  /** A steer that never reached Claude Code. The cursor already counts it, so a
   *  count-based sync would skip it forever: rebuild instead, re-importing it from pi. */
  missedSteer(c: QueryContext, text: string): void {
    c.missedSteer = true;
    this.mirrors.markRebuild(c.piSessionId);
    debug(`provider: steer never reached CC, marked query for rebuild: ${text.slice(0, 60)}`);
  }

  contextForToolResults(results: readonly McpResult[]): QueryContext | undefined {
    for (const { toolCallId } of results) {
      if (toolCallId === undefined) continue;

      for (const c of this.activeQueries) {
        if (
          c.pendingToolCalls.has(toolCallId) ||
          c.pendingResults.has(toolCallId) ||
          c.turnToolCallIds.includes(toolCallId)
        ) {
          return c;
        }
      }
    }

    return undefined;
  }

  /** Whatever a settled session left behind, in one greppable line. Each is a leak with a
   *  real cost: a retained context routes a later orphaned tool result into the delivery
   *  path and returns a stream nobody ends; a pending call is an MCP handler Claude Code
   *  still waits on; a live prompt stream is an unresolved ack. */
  reportLeaks(label: string): void {
    const contexts = [...this.activeQueries];
    const pendingCalls = contexts.reduce((count, c) => count + c.pendingToolCalls.size, 0);
    const liveStreams = contexts.filter((c) => c.promptStream !== null).length;

    if (contexts.length === 0 && pendingCalls === 0 && liveStreams === 0) return;

    debug(
      `WARNING: ${label} left state behind: contexts=${contexts.length} pendingToolCalls=${pendingCalls} promptStreams=${liveStreams}`,
    );
  }
}
