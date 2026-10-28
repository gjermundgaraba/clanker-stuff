import {
  contentText,
  getCurrentSystemMessage,
  getCurrentTools,
  getSystemMessageText,
} from "@earendil-works/pi-ai";
import type {
  Message,
  SystemMessage,
  Tool,
  TranscriptContext,
} from "@earendil-works/pi-ai";

import { debugLogPath } from "./log.js";

/** The conversation, prompt and tools of one provider request. */
export interface BridgeContext {
  messages: Message[];
  system?: SystemMessage;
  tools: Tool[];
}

export const toBridgeContext = (
  transcript: TranscriptContext
): BridgeContext => {
  const { messages } = transcript;
  const system = getCurrentSystemMessage(messages);

  return {
    messages: messages.filter((message) => message.role !== "system"),
    ...(system === undefined ? {} : { system }),
    tools: getCurrentTools(messages),
  };
};

/** The whole system prompt as text, or undefined when there is none. */
export const systemText = (
  system: SystemMessage | undefined
): string | undefined =>
  (system === undefined ? "" : getSystemMessageText(system)) || undefined;

/** Pi's own preamble, the start of every prompt pi renders without a custom prompt. */
export const PI_PREAMBLE =
  "You are an expert coding assistant operating inside pi";

const PI_SECTIONS = new Set(["tools", "rules", "docs", "cwd"]);

const ANTHROPIC_THIRD_PARTY_TRIGGERS = [
  "docs/custom-provider.md",
  "docs/packages.md",
];

const PROJECT_FILE =
  /<project_instructions path="(?<path>[^"]*)">\n(?<body>[\s\S]*?)\n<\/project_instructions>/gu;

interface PromptPart {
  label: string;
  text: string;
}

const labelFor = (name: string): string => {
  if (name === "preamble") {
    return "the custom prompt";
  }

  if (name === "addendum") {
    return "the appended instructions";
  }

  return name === "project_context"
    ? "the project context block"
    : `the ${name} section`;
};

const preambleAtLineStart = (text: string): number => {
  for (
    let offset = text.indexOf(PI_PREAMBLE);
    offset !== -1;
    offset = text.indexOf(PI_PREAMBLE, offset + PI_PREAMBLE.length)
  ) {
    if (offset === 0 || text[offset - 1] === "\n") {
      return offset;
    }
  }

  return -1;
};

const assertSendable = (parts: readonly PromptPart[]): void => {
  const findings: string[] = [];

  for (const { label, text } of parts) {
    const offset = preambleAtLineStart(text);

    if (offset !== -1) {
      findings.push(
        `pi's preamble ("${PI_PREAMBLE}") in ${label}, at offset ${offset} of ${text.length} chars`
      );
    }

    if (
      ANTHROPIC_THIRD_PARTY_TRIGGERS.every((trigger) => text.includes(trigger))
    ) {
      const sources = text
        .matchAll(PROJECT_FILE)
        .filter((match) =>
          ANTHROPIC_THIRD_PARTY_TRIGGERS.some((trigger) =>
            (match.groups?.["body"] ?? "").includes(trigger)
          )
        )
        .map((match) => match.groups?.["path"] ?? "")
        .toArray();

      findings.push(
        `${ANTHROPIC_THIRD_PARTY_TRIGGERS.join(" and ")} in ${label}${sources.length === 0 ? "" : ` (from ${sources.join(", ")})`}`
      );
    }
  }

  if (findings.length === 0) {
    return;
  }

  throw new Error(
    [
      "claude-bridge: refusing to send this prompt. Claude Code's Anthropic path reads a request",
      "  carrying pi's harness, or the phrase pair its subscription gate rejects, as a third-party",
      "  app: it fails with 400 or is billed as extra usage.",
      ...findings.map((finding) => `  Found: ${finding}.`),
      "  If it is your own text, reword or remove it. CLAUDE_BRIDGE_DEBUG=1 writes the full prompt to",
      `  ${debugLogPath()}.`,
    ].join("\n")
  );
};

/** The text appended to Claude Code's preset: every section except pi's own, in pi's
 *  order, and a system message without sections (a replaced prompt) as written. Throws
 *  when what is left still carries pi's harness or the gate's phrase pair. */
export const forwardedPrompt = (
  system: SystemMessage | undefined
): string | undefined => {
  if (system === undefined) {
    return undefined;
  }

  const parts: PromptPart[] = [];
  const content = contentText(system.content);

  if (content !== "") {
    parts.push({ label: "the system prompt", text: content });
  }

  for (const [name, value] of Object.entries(system.sections ?? {})) {
    if (value === null || value === "" || PI_SECTIONS.has(name)) {
      continue;
    }

    if (name === "preamble" && value.startsWith(PI_PREAMBLE)) {
      continue;
    }

    parts.push({ label: labelFor(name), text: value });
  }

  assertSendable(parts);

  return parts.length > 0
    ? parts.map((part) => part.text).join("\n\n")
    : undefined;
};
