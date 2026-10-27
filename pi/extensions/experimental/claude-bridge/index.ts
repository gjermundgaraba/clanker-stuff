import { appendFileSync } from "node:fs";

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { QueryFunction } from "./child.js";
import { providerConfig } from "./provider.js";
import { PROVIDER_ID } from "./session/convert.js";
import { Sessions } from "./sessions.js";

/** The extension, with the Agent SDK's query() replaceable for tests. */
export const createClaudeBridge =
  (runQuery: QueryFunction): ((pi: ExtensionAPI) => void) =>
  (pi) => {
    const sessions = new Sessions(runQuery);

    // The `claude-bridge` provider: Claude Code models served through the Agent SDK.
    const config = providerConfig({
      sessions,
      toolGuidelines: () =>
        new Map(
          pi
            .getAllTools()
            .map((tool) => [tool.name, tool.promptGuidelines ?? []])
        ),
    });

    pi.registerProvider(PROVIDER_ID, config);

    pi.on("session_start", (_event, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();

      sessions.start(sessionId, ctx.cwd, ctx.ui);

      if (config.models?.length === 0) {
        sessions.notify(
          sessionId,
          "claude-bridge: pi-ai's Anthropic catalog has no models; update @earendil-works/pi-ai"
        );
      }
    });

    pi.on("session_shutdown", (_event, ctx) => {
      sessions.end(ctx.sessionManager.getSessionId());
    });
  };

/** CLAUDE_BRIDGE_RECORD_STREAM=<path> appends every SDK message as a JSON line, for
 *  capturing replay fixtures of what Claude Code really emits. */
const recording =
  (run: QueryFunction, recordPath: string): QueryFunction =>
  (params) => {
    const sdkQuery = run(params);

    return {
      interrupt: async () => await sdkQuery.interrupt(),
      close: () => {
        sdkQuery.close();
      },
      async *[Symbol.asyncIterator]() {
        for await (const message of sdkQuery) {
          appendFileSync(recordPath, `${JSON.stringify(message)}\n`);
          yield message;
        }
      },
    };
  };

const recordPath = process.env["CLAUDE_BRIDGE_RECORD_STREAM"];

export default createClaudeBridge(
  recordPath === undefined || recordPath === ""
    ? query
    : recording(query, recordPath)
);
