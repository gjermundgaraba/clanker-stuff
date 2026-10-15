// Tool results travel back to Claude Code through parked MCP handlers. Pi does not hand
// a provider its tool results directly: it appends them to the context and calls the
// provider again, so they are scraped back off the context tail and released to the
// handlers waiting for them.

import type { Message, ToolResultMessage, Tool } from "@earendil-works/pi-ai";
import type {
  McpSdkServerConfigWithInstance,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";

import { debug } from "../log.js";
import { createToolServer, jsonSchema } from "../mcp-server.js";
import { MCP_SERVER_NAME } from "../tools.js";
import type { QueryContext } from "./context.js";
import { userMessage } from "./prompt-stream.js";

export type McpContent = (
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
)[];

export interface McpResult {
  content: McpContent;
  isError?: boolean;
  toolCallId?: string;
}

export function toolResultToMcpContent(content: ToolResultMessage["content"]): McpContent {
  const blocks: McpContent = [];

  for (const block of content) {
    if (block.type === "text") {
      if (block.text !== "") blocks.push({ type: "text", text: block.text });
    } else if (block.data !== "" && block.mimeType !== "") {
      blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
    }
  }

  return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}

/** This turn's tool results: walks back from the context tail to the nearest assistant
 *  message, past user messages pi injected mid-tool (steers and follow-ups). */
export function extractAllToolResults(messages: readonly Message[]): McpResult[] {
  const results: McpResult[] = [];
  let stopIndex = -1;

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];

    if (message?.role === "toolResult") {
      results.unshift({
        content: toolResultToMcpContent(message.content),
        isError: message.isError,
        toolCallId: message.toolCallId,
      });
    } else if (message?.role === "assistant") {
      stopIndex = index;
      break;
    }
  }

  debug(
    `extractAllToolResults: ${results.length} results from ${messages.length} msgs, stopped at index ${stopIndex}`,
  );

  for (const [index, result] of results.entries()) {
    debug(
      `extractAllToolResults: result[${index}] id=${result.toolCallId}${result.isError === true ? " ERROR" : ""} preview:`,
      JSON.stringify(result.content).slice(0, 150),
    );
  }

  return results;
}

// An MCP server bridging pi tools to the SDK. Each handler blocks on a promise until pi
// delivers the result through the next provider call. The handler and pi's result can
// arrive in either order, hence two maps: a result that lands first waits in
// `pendingResults`, and a handler that runs first parks its resolver in
// `pendingToolCalls`. Handlers close over their own query's context, so concurrent
// queries stay apart.
export function buildMcpServers(
  tools: readonly Tool[],
  queryCtx: QueryContext,
): Record<string, McpSdkServerConfigWithInstance> | undefined {
  if (tools.length === 0) return undefined;

  const server = createToolServer(
    MCP_SERVER_NAME,
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: jsonSchema(tool.name, tool.parameters),
      handler: async (toolCallId: string) => {
        const queued = queryCtx.pendingResults.get(toolCallId);

        if (queued !== undefined) {
          queryCtx.pendingResults.delete(toolCallId);
          debug(
            `mcp handler: ${tool.name} [${toolCallId}] → resolved from queue (${queryCtx.pendingResults.size} remaining)`,
          );

          return queued;
        }

        debug(`mcp handler: ${tool.name} [${toolCallId}] → waiting`);

        return new Promise<McpResult>((resolve) => {
          queryCtx.pendingToolCalls.set(toolCallId, { toolName: tool.name, resolve });
        });
      },
    })),
  );

  return { [MCP_SERVER_NAME]: server };
}

const steerText = (steer: readonly ContentBlockParam[]): string =>
  steer.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n");

/**
 * Releases this turn's tool results to their MCP handlers, after first pushing any steer
 * to Claude Code.
 *
 * The order is mandatory: the steer and the MCP tool result travel over the same stdin
 * FIFO, and awaiting the push ack (resolved only once the write completed) before
 * resolving any handler makes Claude Code enqueue the steer before it reads the result,
 * so its post-tool-call drain acts on it this turn. Resolved first, the steer misses the
 * drain and silently degrades to a follow-up. Both are CLI internals, not SDK contract.
 *
 * @param onMissedSteer the steer never reached Claude Code; its session must rebuild.
 * @param warn surfaces a stuck-handler warning to the user.
 */
export async function deliverToolResults(
  c: QueryContext,
  results: readonly McpResult[],
  steer: ContentBlockParam[] | undefined,
  onMissedSteer: (c: QueryContext, text: string) => void,
  warn: (message: string) => void,
): Promise<void> {
  if (steer !== undefined) {
    const text = steerText(steer);
    const promptStream = c.promptStream;

    if (promptStream === null) {
      debug(`WARNING: steer with no prompt stream, dropping: ${text.slice(0, 60)}`);
      onMissedSteer(c, text);
    } else {
      const message: SDKUserMessage = userMessage(steer, "next");

      try {
        await promptStream.push(message);
        debug(`provider: steer written to CC stdin before tool result: ${text.slice(0, 60)}`);
      } catch (error) {
        // The query is ending, so the steer does not reach it. It is still in pi's
        // context and the cursor already counts it, so force a rebuild or Claude Code
        // would never see it.
        debug("provider: steer push rejected, delivering tool result anyway:", error);
        onMissedSteer(c, text);
      }
    }
  }

  debug(
    `provider: tool results, ${results.length} results, ${c.pendingToolCalls.size} waiting handlers`,
  );

  for (const result of results) {
    const id = result.toolCallId;
    const pending = id === undefined ? undefined : c.pendingToolCalls.get(id);

    if (id === undefined) {
      debug("WARNING: tool result without toolCallId, cannot match");
    } else if (pending === undefined) {
      c.pendingResults.set(id, result);
      debug(`provider: queued result [${id}] (${c.pendingResults.size} pending)`);
    } else {
      c.pendingToolCalls.delete(id);
      debug(
        `provider: resolving ${pending.toolName} [${id}]${result.isError === true ? " (error)" : ""}`,
        JSON.stringify(result.content).slice(0, 200),
      );
      pending.resolve(result);
    }

    if (c.pendingToolCalls.size > 0 && c.pendingResults.size > 0) {
      debug(
        `BUG: both maps non-empty! handlers=${c.pendingToolCalls.size} results=${c.pendingResults.size}`,
      );
    }
  }

  if (c.pendingToolCalls.size > 0) {
    debug(
      `WARNING: ${c.pendingToolCalls.size} MCP handlers still waiting after delivering ${results.length} results`,
    );
    warn(
      `Claude bridge: ${c.pendingToolCalls.size} tool handler(s) still waiting; provider may be stuck`,
    );
  }
}
