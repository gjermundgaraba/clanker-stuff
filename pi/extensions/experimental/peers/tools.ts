import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { callLine, listResult, sendResult } from "./render.js";
import { peerRows } from "./report.js";
import type { PeerRuntime } from "./runtime.js";

const reply = <T>(text: string, details: T) => ({
  content: [{ type: "text" as const, text }],
  details,
});

export const registerPeerTools = (
  pi: ExtensionAPI,
  runtime: PeerRuntime
): void => {
  pi.registerTool({
    name: "peer_send",
    label: "Send to peer",
    description:
      "Send a message to another running Pi session by its session name. It arrives in that session as a message that starts its turn. Fails with an error when no live session has that name.",
    promptSnippet: "Message another running Pi session by name",
    promptGuidelines: [
      "After asking a peer something with peer_send, end your turn; its reply arrives as a message that wakes you. Do not poll or sleep.",
      "Answer a message from a peer with peer_send to its sender; text you write in your turn never reaches it.",
      "If peer_send fails, tell the user why instead of guessing another name.",
    ],
    parameters: Type.Object(
      {
        to: Type.String({
          minLength: 1,
          description: "The recipient's session name.",
        }),
        text: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false }
    ),
    execute: async (_id, params, _signal, _update, ctx) => {
      const letter = await runtime.send(params.to, params.text, ctx);

      return reply(
        `Delivered ${letter.id} to "${letter.to}"'s inbox. Any reply arrives as a message that wakes you; end your turn instead of polling.`,
        letter
      );
    },
    renderCall: (args, theme) => callLine(theme, "peer_send", args.to),
    renderResult: (result, options, theme, context) =>
      sendResult(theme, result, options, context.isError),
  });
  pi.registerTool({
    name: "peer_list",
    label: "List peers",
    description:
      "List the running Pi sessions that have a name, so you can message one with peer_send.",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => {
      const list = await runtime.peers();

      return reply(peerRows(list), list);
    },
    renderCall: (_args, theme) => callLine(theme, "peer_list", undefined),
    renderResult: (result, options, theme, context) =>
      listResult(theme, result, options, context.isError),
  });
};
