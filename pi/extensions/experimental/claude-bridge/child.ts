// What every Claude Code subprocess the bridge spawns runs with.

import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/** The part of the SDK's `Query` the bridge uses: its messages, and stopping it. */
export interface BridgeQuery
  extends AsyncIterable<SDKMessage>, Pick<Query, "interrupt" | "close"> {}

export interface QueryParams {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options: Options;
}

export type QueryFunction = (params: QueryParams) => BridgeQuery;

/** Applied to every Claude Code child.
 *  - ENABLE_CLAUDEAI_MCP_SERVERS=0: keep claude.ai-connected MCP servers out; pi serves
 *    its own tools, and these are not blocked by --strict-mcp-config.
 *  - DISABLE_AUTO_COMPACT=1: pi owns compaction. Claude Code compacting its own copy
 *    would diverge from pi's history, the source of truth for every rebuild, and race
 *    pi's threshold.
 *  - CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1: no update checks, MCP registry or
 *    telemetry from a child that only serves inference. */
const CHILD_ENV = {
  ENABLE_CLAUDEAI_MCP_SERVERS: "0",
  DISABLE_AUTO_COMPACT: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
} as const;

export const childEnv = (): NodeJS.ProcessEnv => ({ ...process.env, ...CHILD_ENV });

/** Stop a query now: interrupt() asks the CLI to stop gracefully and close() kills it.
 *  Both are needed, since interrupt alone lets the current API call finish. Neither may
 *  throw out of an abort path. */
export function stopQuery(query: BridgeQuery | undefined): void {
  if (query === undefined) return;

  void query.interrupt().catch(() => {});

  try {
    query.close();
  } catch {
    // Already gone.
  }
}
