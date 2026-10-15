// Pi hands providers a transcript: the prompt and tool set live in system messages,
// plus later section patches and tool deltas. The bridge's downstream consumers
// (cursor writes, session sync, prompt-capture lookup) work on the prompt/tools
// fields instead, so this folds the transcript back out.
//
// pi-ai replays the system state but keeps section replay order, while prompt
// capture keys come from pi's canonical section builder. A deleted and re-added
// section must be ranked back into canonical order before the exact-key lookup.

import { contentText, getCurrentSystemMessage, getCurrentTools } from "@earendil-works/pi-ai";
import type { Context, Message, SystemMessage, TranscriptContext } from "@earendil-works/pi-ai";

/** pi's canonical built-in section order. A name absent from the table is a custom
 *  section (anything an extension set through `systemPromptOptions.sections`, such as
 *  pi's `mcp_servers`), which the builder renders after every built-in.
 *
 *  Known limitation: customs keep their replayed relative order, while the builder
 *  takes theirs from `systemPromptOptions.sections`. They disagree only when a custom
 *  moves without its content changing; the exact-key lookup then fails that turn. A
 *  future built-in missing here also sorts last and fails loudly until it is added,
 *  which beats silently misordering today's custom sections. */
const SECTION_RANK = new Map<string, number>([
  ["preamble", 0],
  ["tools", 1],
  ["rules", 2],
  ["docs", 3],
  ["addendum", 4],
  ["project_context", 5],
  ["skills", 6],
  ["cwd", 7],
]);

const CUSTOM_SECTION_RANK = Math.max(...SECTION_RANK.values()) + 1;

/** Render replayed system state in the same section order as pi's prompt builder. */
function canonicalSystemPrompt(message: SystemMessage | undefined): string | undefined {
  if (message === undefined) return undefined;

  const sections = Object.entries(message.sections ?? {})
    .flatMap(([name, value]) => (value === null ? [] : [{ name, value }]))
    // Array sort is stable, so customs keep their replayed order among themselves.
    .toSorted(
      (a, b) =>
        (SECTION_RANK.get(a.name) ?? CUSTOM_SECTION_RANK) -
        (SECTION_RANK.get(b.name) ?? CUSTOM_SECTION_RANK),
    );

  const parts = [contentText(message.content), ...sections.map(({ value }) => value)].filter(
    (part) => part.length > 0,
  );

  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** `messages` without the prompt-state system messages. */
export function nonSystemMessages(messages: readonly Message[]): Message[] {
  return messages.filter((message) => message.role !== "system");
}

/** The prompt and tool fields the bridge works with, with prompt-state messages removed
 *  from conversation history. */
export function toBridgeContext(context: TranscriptContext): Context {
  const { messages } = context;

  if (!messages.some((message) => message.role === "system")) return { messages };

  const systemPrompt = canonicalSystemPrompt(getCurrentSystemMessage(messages));
  const tools = getCurrentTools(messages);

  return {
    messages: nonSystemMessages(messages),
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    ...(tools.length > 0 ? { tools } : {}),
  };
}
