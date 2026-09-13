import type { ContextEvent } from "@earendil-works/pi-coding-agent";

import { parentAgentPath } from "./protocol.js";

export const CHILD_CONTEXT_TYPE = "clanker-subagents-v2-context";
const MAX_CHILDREN = 8;
const MAX_BYTES = 1024;
const OPEN = "  <subagents>\n";
const CLOSE = "  </subagents>\n";

/** The budget includes the native subagents wrapper and indentation. */
export const childContextSummary = (
  parent: string,
  agents: readonly { path: string; resident: boolean }[],
): string => {
  const children = agents
    .filter(({ path }) => parentAgentPath(path) === parent)
    .toSorted((left, right) =>
      left.resident === right.resident
        ? left.path < right.path
          ? -1
          : left.path > right.path
            ? 1
            : 0
        : Number(right.resident) - Number(left.resident),
    );
  const lines: string[] = [];
  let bytes = Buffer.byteLength(OPEN + CLOSE, "utf8");
  for (const child of children) {
    if (lines.length === MAX_CHILDREN) {
      break;
    }
    const line = `    <agent name="${child.path}" />\n`;
    const size = Buffer.byteLength(line, "utf8");
    if (bytes + size <= MAX_BYTES) {
      bytes += size;
      lines.push(line);
    }
  }
  return lines.length === 0 ? "" : `${OPEN}${lines.join("")}${CLOSE}`;
};

/** Ephemeral prefix: never changes the durable branch used by provider replay. */
export const withChildContext = (messages: ContextEvent["messages"], summary: string) => ({
  messages: [
    ...(summary === ""
      ? []
      : [
          {
            content: `<environment_context>\n${summary}</environment_context>`,
            customType: CHILD_CONTEXT_TYPE,
            display: false,
            role: "custom" as const,
            timestamp: 0,
          },
        ]),
    ...messages.filter(
      (message) => message.role !== "custom" || message.customType !== CHILD_CONTEXT_TYPE,
    ),
  ],
});
