import { appendFileSync } from "node:fs";

import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

export interface BridgeQuery
  extends AsyncIterable<SDKMessage>, Pick<Query, "interrupt" | "close"> {}

export interface QueryParams {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options: Options;
}

export type QueryFunction = (params: QueryParams) => BridgeQuery;

/** Optional proxy or gateway settings injected only into the Claude Code child process. */
export interface ChildGateway {
  baseUrl?: string;
  authToken?: string;
}

const CHILD_DEFAULTS = {
  CLAUDE_CODE_MAX_RETRIES: "15",
} as const;

const CHILD_ENV = {
  ENABLE_CLAUDEAI_MCP_SERVERS: "0",
  DISABLE_AUTO_COMPACT: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
} as const;

export const childEnv = (gateway?: ChildGateway): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...CHILD_DEFAULTS,
    ...process.env,
    ...CHILD_ENV,
  };

  if (gateway?.baseUrl !== undefined) {
    env["ANTHROPIC_BASE_URL"] = gateway.baseUrl;
  }

  if (gateway?.authToken !== undefined) {
    env["ANTHROPIC_AUTH_TOKEN"] = gateway.authToken;
    delete env["ANTHROPIC_API_KEY"];
  }

  return env;
};

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

/** `run`, with best-effort JSONL capture to `CLAUDE_BRIDGE_RECORD_STREAM` for replay fixtures. */
export const recordStream = (run: QueryFunction): QueryFunction => {
  const recordPath = process.env["CLAUDE_BRIDGE_RECORD_STREAM"];

  if (recordPath === undefined || recordPath === "") {
    return run;
  }

  const record = (message: SDKMessage): void => {
    try {
      appendFileSync(recordPath, `${JSON.stringify(message)}\n`);
    } catch {
      return;
    }
  };

  return (params) => {
    const sdkQuery = run(params);

    return {
      interrupt: async () => await sdkQuery.interrupt(),
      close: () => {
        sdkQuery.close();
      },
      async *[Symbol.asyncIterator]() {
        for await (const message of sdkQuery) {
          record(message);
          yield message;
        }
      },
    };
  };
};
