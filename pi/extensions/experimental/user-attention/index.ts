import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  AsyncMessageParameters,
  sendAttention,
  renderAttention,
  renderCall,
  renderResult,
} from "./attention.js";

export default function userAttention(pi: ExtensionAPI) {
  pi.registerTool({
    name: "send_message_to_user_async",
    label: "Message for you",
    description:
      "Send a concise message that needs the user's attention during ongoing work. The tool returns immediately without ending the turn or waiting for a reply; any reply arrives asynchronously as a new user message. Use this tool to report a critical blocker or a finding that may change the task's direction, or to answer a user question or status request received while work is still in progress. Use commentary for routine progress and intermediate context.",
    parameters: AsyncMessageParameters,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    renderCall,
    renderResult,
    executionMode: "sequential",
    execute: async (_id, params, _signal, _update, ctx) => sendAttention(pi, params, ctx),
  });
  pi.registerEntryRenderer("async-attention", renderAttention);
}
