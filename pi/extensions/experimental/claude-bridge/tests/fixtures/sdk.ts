// Claude Code SDK messages for tests: the streams recorded in sdk-streams/, and
// hand-built frames for what cannot be recorded on demand (a stalled stream, a 429, a
// tool name the bridge does not serve).

import { readFileSync } from "node:fs";

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessageEvent, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  NonNullableUsage,
  SDKAssistantMessage,
  SDKSystemMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKRateLimitEvent,
  SDKRateLimitInfo,
  SDKResultError,
  SDKResultSuccess,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  BetaContentBlock,
  BetaMessage,
  BetaRawMessageStreamEvent,
  BetaStopReason,
  BetaTextBlock,
  BetaUsage,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

/** Turns recorded from live Claude Code with CLAUDE_BRIDGE_RECORD_STREAM, ids scrubbed. */
export type RecordedStream = "text" | "single-tool" | "parallel-tools";

export function recordedStream(name: RecordedStream): SDKMessage[] {
  const lines = readFileSync(new URL(`./sdk-streams/${name}.jsonl`, import.meta.url), "utf8").split(
    "\n",
  );

  return lines
    .filter((line) => line !== "")
    .map((line) => {
      const raw: unknown = JSON.parse(line);

      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Verbatim Claude Code output from the SDK this bridge pins; the SDK's own declaration is the contract the recording captured.
      return raw as SDKMessage;
    });
}

/** A real pi stream, plus what the bridge pushed to it and whether it ended it. Each
 *  event's type also goes to `log`, for interleaving with other observers. */
export interface RecordingStream {
  readonly stream: AssistantMessageEventStream;
  readonly events: AssistantMessageEvent[];
  readonly ended: boolean;
}

export function recordingStream(log: string[] = []): RecordingStream {
  const stream = createAssistantMessageEventStream();
  const events: AssistantMessageEvent[] = [];
  let ended = false;
  const push = stream.push.bind(stream);
  const end = stream.end.bind(stream);

  // pi-ai exports the stream class as a type only, so the instance is wrapped rather
  // than subclassed; it still queues and ends exactly as pi's own streams do.
  stream.push = (event) => {
    events.push(event);
    log.push(event.type);
    push(event);
  };

  stream.end = (result) => {
    ended = true;
    end(result);
  };

  return {
    stream,
    events,
    get ended() {
      return ended;
    },
  };
}

const SESSION_ID = "00000000-0000-4000-8000-000000000001";

const envelope = {
  parent_tool_use_id: null,
  uuid: "00000000-0000-4000-8000-000000000002",
  session_id: SESSION_ID,
} as const;

const usage = (): BetaUsage => ({
  cache_creation: null,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
  fallback_credit: null,
  inference_geo: null,
  input_tokens: 0,
  iterations: null,
  output_tokens: 0,
  output_tokens_details: null,
  server_tool_use: null,
  service_tier: null,
  speed: null,
});

const betaMessage = (id: string, content: BetaContentBlock[], model: string): BetaMessage => ({
  id,
  container: null,
  content,
  context_management: null,
  diagnostics: null,
  model,
  role: "assistant",
  stop_details: null,
  stop_reason: null,
  stop_sequence: null,
  type: "message",
  usage: usage(),
});

/** Claude Code's first message: the session id the bridge records for the query. */
export const init = (sessionId: string): SDKSystemMessage => ({
  type: "system",
  subtype: "init",
  apiKeySource: "none",
  claude_code_version: "test",
  cwd: "/",
  tools: [],
  mcp_servers: [],
  model: "claude-haiku-4-5",
  permissionMode: "bypassPermissions",
  slash_commands: [],
  output_style: "default",
  skills: [],
  plugins: [],
  uuid: envelope.uuid,
  session_id: sessionId,
});

const streamEvent = (event: BetaRawMessageStreamEvent): SDKPartialAssistantMessage => ({
  type: "stream_event",
  event,
  ...envelope,
});

export const messageStart = (id: string): SDKPartialAssistantMessage =>
  streamEvent({ type: "message_start", message: betaMessage(id, [], "claude-haiku-4-5") });

export const textStart = (index: number): SDKPartialAssistantMessage =>
  streamEvent({
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "", citations: null },
  });

export const thinkingStart = (index: number): SDKPartialAssistantMessage =>
  streamEvent({
    type: "content_block_start",
    index,
    content_block: { type: "thinking", thinking: "", signature: "" },
  });

export const toolUseStart = (index: number, name: string, id: string): SDKPartialAssistantMessage =>
  streamEvent({
    type: "content_block_start",
    index,
    content_block: { type: "tool_use", name, id, input: {} },
  });

export const textDelta = (index: number, text: string): SDKPartialAssistantMessage =>
  streamEvent({ type: "content_block_delta", index, delta: { type: "text_delta", text } });

export const thinkingDelta = (index: number, thinking: string): SDKPartialAssistantMessage =>
  streamEvent({
    type: "content_block_delta",
    index,
    delta: { type: "thinking_delta", thinking, estimated_tokens: null },
  });

export const inputJsonDelta = (index: number, partialJson: string): SDKPartialAssistantMessage =>
  streamEvent({
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json: partialJson },
  });

export const blockStop = (index: number): SDKPartialAssistantMessage =>
  streamEvent({ type: "content_block_stop", index });

export const messageDelta = (stopReason: BetaStopReason): SDKPartialAssistantMessage =>
  streamEvent({
    type: "message_delta",
    context_management: null,
    delta: { container: null, stop_details: null, stop_reason: stopReason, stop_sequence: null },
    usage: {
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      fallback_credit: null,
      input_tokens: null,
      iterations: null,
      output_tokens: 0,
      output_tokens_details: null,
      server_tool_use: null,
    },
  });

export const messageStop = (): SDKPartialAssistantMessage => streamEvent({ type: "message_stop" });

export const textBlock = (text: string): BetaTextBlock => ({ type: "text", text, citations: null });

/** A complete assistant message: what follows a stream, or replaces a stalled one. */
export const assistantMessage = (
  id: string,
  content: BetaContentBlock[],
  model = "claude-haiku-4-5",
): SDKAssistantMessage => ({
  type: "assistant",
  message: betaMessage(id, content, model),
  ...envelope,
});

/** Claude Code's own failure report: a `<synthetic>` assistant message, not model output. */
export const syntheticReport = (text: string): SDKAssistantMessage =>
  assistantMessage("msg_synthetic", [textBlock(text)], "<synthetic>");

const resultUsage: NonNullableUsage = {
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  fallback_credit: null,
  inference_geo: "not_available",
  input_tokens: 0,
  iterations: [],
  output_tokens: 0,
  output_tokens_details: { thinking_tokens: 0 },
  server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
  service_tier: "standard",
  speed: "standard",
};

const resultFields = () => ({
  duration_ms: 0,
  duration_api_ms: 0,
  num_turns: 1,
  stop_reason: null,
  total_cost_usd: 0,
  usage: resultUsage,
  modelUsage: {},
  permission_denials: [],
  ...envelope,
});

/** A success-shaped result; `isError` is how Claude Code reports an API failure. */
export const successResult = (result: string, isError = false): SDKResultSuccess => ({
  type: "result",
  subtype: "success",
  is_error: isError,
  result,
  ...resultFields(),
});

export const errorResult = (
  subtype: SDKResultError["subtype"],
  errors: string[],
): SDKResultError => ({
  type: "result",
  subtype,
  is_error: true,
  errors,
  ...resultFields(),
});

export const rateLimitEvent = (info: SDKRateLimitInfo): SDKRateLimitEvent => ({
  type: "rate_limit_event",
  rate_limit_info: info,
  uuid: envelope.uuid,
  session_id: SESSION_ID,
});
