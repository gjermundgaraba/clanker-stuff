import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

/** The part of the SDK's `Query` the bridge uses: its messages, and stopping it. */
export interface BridgeQuery
  extends AsyncIterable<SDKMessage>, Pick<Query, "interrupt" | "close"> {}

export interface QueryParams {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options: Options;
}

export type QueryFunction = (params: QueryParams) => BridgeQuery;

const CHILD_ENV = {
  ENABLE_CLAUDEAI_MCP_SERVERS: "0",
  DISABLE_AUTO_COMPACT: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
} as const;

export const childEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  ...CHILD_ENV,
});

/** Stop a query now: interrupt() asks the CLI to stop gracefully and close() kills it.
 *  Both are needed, since interrupt alone lets the current API call finish. Neither may
 *  throw out of an abort path. */
export const stopQuery = (query: BridgeQuery | undefined): void => {
  if (query === undefined) {
    return;
  }

  void query.interrupt().catch(() => undefined);

  try {
    query.close();
  } catch {
    return;
  }
};
