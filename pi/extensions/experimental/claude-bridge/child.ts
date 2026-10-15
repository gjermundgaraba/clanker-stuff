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

/** Applied to every child, provider and summary alike, so a guard is added once.
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

// Pi owns context files, so Claude Code must not load its own on top: project
// CLAUDE.md/AGENTS.md would arrive twice, and ~/.claude/CLAUDE.md (a persona written for
// another harness) would arrive at all, stamped as overriding default behavior. Excludes
// rather than settingSources: the same source gate reads settings.json, where
// Bedrock/Vertex users keep `env` and `apiKeyHelper`. Patterns match absolute paths;
// rules need their own. Managed policy memory is not excludable by design.
export const CLAUDE_MD_EXCLUDES = ["**/CLAUDE.md", "**/AGENTS.md", "**/.claude/rules/**"];

/** Stop a query now: interrupt() asks the CLI to stop gracefully and close() kills it.
 *  Both are needed, since interrupt alone lets the current API call finish. Neither may
 *  throw out of an abort path. */
export function stopQuery(query: BridgeQuery | null | undefined): void {
  if (query == null) return;

  void query.interrupt().catch(() => {});

  try {
    query.close();
  } catch {
    // Already gone.
  }
}
