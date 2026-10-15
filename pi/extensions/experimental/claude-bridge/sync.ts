// What a provider request does with the Claude Code conversation behind its pi session.
// Decided from message content: the conversation records a fingerprint of every pi
// message Claude Code holds, and a request either extends that record exactly or it does
// not. Counting messages cannot tell a compaction, a context edit or a missed steer from
// an ordinary turn; comparing them can.

import { createHash } from "node:crypto";

import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";

import type { BridgeContext } from "./prompt.js";
import { systemPromptText } from "./prompt.js";
import { turnStart } from "./turn.js";

const fingerprints = new WeakMap<Message, string>();

const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("base64url");

/** A pi message's identity for sync: its role and content, plus the tool call a result
 *  answers. Timestamps, usage, stop reason and model fields are not part of it. */
export function fingerprint(message: Message): string {
  const cached = fingerprints.get(message);

  if (cached !== undefined) return cached;

  const value = hash([
    message.role,
    message.content,
    message.role === "toolResult" ? message.toolCallId : null,
  ]);

  fingerprints.set(message, value);

  return value;
}

/** The prompt and tools a query was started with. A parked query only continues while
 *  they are unchanged: its MCP server and system prompt are fixed for its lifetime. */
export const promptKey = (context: BridgeContext): string =>
  hash([
    systemPromptText(context.system) ?? null,
    (context.tools ?? []).map(({ name, description, parameters }) => [
      name,
      description,
      parameters,
    ]),
  ]);

/** The conversation as the decision needs it. */
export interface SyncState {
  /** Fingerprints of the pi messages Claude Code holds, oldest first. Only messages pi
   *  sent: never the continue prompt or anything Claude Code writes to its own file. */
  sent: readonly string[];
  /** A query is running (streaming or parked at a tool call). */
  busy: boolean;
  /** The query parked at a tool call: the prompt it started with and the calls it waits on. */
  parked?: { promptKey: string; waiting: ReadonlySet<string> } | undefined;
}

export type RebuildReason =
  /** Nothing recorded yet: a first turn, or the record was dropped (abort, failure). */
  | "none"
  /** pi's history no longer starts with what Claude Code holds (compaction, tree
   *  navigation, a context edit, a retried attempt pi hid). */
  | "diverged"
  /** pi's history extends the record by more than the new user turn (another
   *  provider's turns, tool results with no query parked on them, a missed steer). */
  | "tail";

export type Plan =
  /** Hand the results, and the steer after them, to the parked query. */
  | { kind: "deliver"; results: ToolResultMessage[]; steer: Message[] }
  /** A request made while a query runs that is not its continuation: an extension's
   *  one-off under the live session id. It must not disturb the running query. */
  | { kind: "side" }
  /** Resume Claude Code's session with the new user turn. */
  | { kind: "resume"; turn: Message[] }
  /** Rewrite Claude Code's session from `priors`, then send `turn`, or the continue
   *  prompt when the history ends in tool results and there is no turn. */
  | { kind: "rebuild"; reason: RebuildReason; priors: Message[]; turn: Message[] };

const continuesFrom = (history: readonly Message[], sent: readonly string[]): boolean =>
  history.length >= sent.length &&
  sent.every((value, index) => {
    const message = history[index];

    return message !== undefined && fingerprint(message) === value;
  });

/** The tool results that answer a parked query, then the steer pi queued after them. */
function delivery(
  tail: readonly Message[],
  waiting: ReadonlySet<string>,
): Extract<Plan, { kind: "deliver" }> | undefined {
  const results: ToolResultMessage[] = [];
  let index = 0;

  for (; index < tail.length; index++) {
    const message = tail[index];

    if (message?.role !== "toolResult") break;

    if (!waiting.has(message.toolCallId)) return undefined;

    results.push(message);
  }

  const steer = tail.slice(index);

  if (results.length === 0 || steer.some((message) => message.role !== "user")) return undefined;

  return { kind: "deliver", results, steer };
}

export function plan(state: SyncState, context: BridgeContext): Plan {
  const history = context.messages;
  const continues = continuesFrom(history, state.sent);

  if (state.parked !== undefined && continues && promptKey(context) === state.parked.promptKey) {
    const delivered = delivery(history.slice(state.sent.length), state.parked.waiting);

    if (delivered !== undefined) return delivered;
  }

  if (state.busy && history.at(-1)?.role === "user") return { kind: "side" };

  const start = turnStart(history);
  const priors = history.slice(0, start);
  const turn = history.slice(start);

  if (state.sent.length === 0) return { kind: "rebuild", reason: "none", priors, turn };

  if (!continues) return { kind: "rebuild", reason: "diverged", priors, turn };

  if (state.sent.length === start && turn.length > 0) return { kind: "resume", turn };

  return { kind: "rebuild", reason: "tail", priors, turn };
}
