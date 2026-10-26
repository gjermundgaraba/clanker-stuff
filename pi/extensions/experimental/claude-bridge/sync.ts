// What a provider request does with the Claude Code conversation behind its pi session.
// Decided from message content: the conversation keeps every pi message Claude Code
// holds, and a request either extends that record exactly or it does not. Counting
// messages cannot tell a compaction, a context edit or a missed steer from an ordinary
// turn; comparing them can.

import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";

import type { BridgeContext } from "./prompt.js";
import { systemText } from "./prompt.js";
import { turnStart } from "./turn.js";

/** A pi message's identity for sync: its role and content, plus the tool call a result
 *  answers. Timestamps, usage, stop reason and model fields are not part of it. */
const identity = (message: Message): string =>
  JSON.stringify([
    message.role,
    message.content,
    message.role === "toolResult" ? message.toolCallId : null,
  ]);

/** How many messages from the start of `history` match `held`. Equal to `held.length`
 *  when `history` continues it. The conversation holds copies, so content is compared. */
export function matchedPrefix(history: readonly Message[], held: readonly Message[]): number {
  const index = held.findIndex((message, at) => {
    const current = history[at];

    return current === undefined || identity(current) !== identity(message);
  });

  return index === -1 ? held.length : index;
}

/** What a query is fixed to once it starts: Claude Code's model and effort, the system
 *  prompt, and the MCP server's tools. A parked query only continues while it holds. */
export const queryKey = (
  context: BridgeContext,
  model: string,
  effort: string | undefined,
): string =>
  JSON.stringify([
    model,
    effort ?? null,
    systemText(context.system) ?? null,
    context.tools.map(({ name, description, parameters }) => [name, description, parameters]),
  ]);

/** The conversation as the decision needs it. */
export interface SyncState {
  /** The pi messages Claude Code holds, oldest first. Only messages pi sent: never the
   *  continue prompt or anything Claude Code writes to its own file. */
  held: readonly Message[];
  /** The Claude Code session holding them. */
  session: string | undefined;
  /** A query is running (streaming or parked at a tool call). */
  busy: boolean;
  /** The query parked at a tool call: what it is fixed to and the calls it waits on. */
  parked: { key: string; waiting: ReadonlySet<string> } | undefined;
}

/** One provider request as the decision reads it. */
export interface SyncRequest {
  context: BridgeContext;
  /** The request's `queryKey`. */
  key: string;
  /** pi aborted the run the request belongs to. */
  aborted: boolean;
}

export type RebuildReason =
  /** Nothing held: a first turn, or the record was dropped (abort, failure, a kill). */
  | "none"
  /** pi's history no longer starts with what Claude Code holds (compaction, tree
   *  navigation, a context edit, a retried attempt pi hid). */
  | "diverged"
  /** pi's history extends the record by more than the new user turn (another
   *  provider's turns, tool results with no query parked on them, a missed steer). */
  | "tail"
  /** The parked query's results arrived under another model, effort, prompt or tools. */
  | "changed";

export type Plan =
  /** Hand the results, and the steer after them, to the parked query. */
  | { kind: "deliver"; results: ToolResultMessage[]; steer: Message[] }
  /** A request made while a query runs that is not its continuation: an extension's
   *  one-off under the live session id. It must not disturb the running query. */
  | { kind: "side" }
  /** pi reports a tool's result after aborting the run: end the call with no query. */
  | { kind: "finish" }
  /** Resume Claude Code's session with the new user turn. */
  | { kind: "resume"; session: string; turn: Message[] }
  /** Write a new session from `priors`, then send `turn`, or the continue prompt when the
   *  history ends in tool results and there is no turn. `matched` is how much of what
   *  Claude Code held pi's history still starts with. */
  | {
      kind: "rebuild";
      reason: RebuildReason;
      matched: number;
      priors: Message[];
      turn: Message[];
    };

/** The results a parked query waits on, read from the end of pi's history: tool results
 *  for its calls, then the user messages pi queued after them (a steer). Read from the end
 *  so a rewritten history (a compaction while the tool ran) is still recognised as the
 *  conversation's next step, not someone else's request. */
function trailingDelivery(
  history: readonly Message[],
  waiting: ReadonlySet<string>,
): { at: number; results: ToolResultMessage[]; steer: Message[] } | undefined {
  const steerAt = turnStart(history);
  const results: ToolResultMessage[] = [];
  let at = steerAt;

  for (let message = history[at - 1]; message?.role === "toolResult"; message = history[at - 1]) {
    if (!waiting.has(message.toolCallId)) return undefined;

    results.unshift(message);
    at--;
  }

  return results.length === 0 ? undefined : { at, results, steer: history.slice(steerAt) };
}

export function plan(state: SyncState, request: SyncRequest): Plan {
  const history = request.context.messages;
  const matched = matchedPrefix(history, state.held);
  const continues = matched === state.held.length;
  const start = turnStart(history);

  const rebuild = (reason: RebuildReason): Plan => ({
    kind: "rebuild",
    reason,
    matched,
    priors: history.slice(0, start),
    turn: history.slice(start),
  });

  // The results the parked query waits on make this its conversation's next step; whether
  // the query can take them is another matter.
  const { parked } = state;
  const delivered = parked === undefined ? undefined : trailingDelivery(history, parked.waiting);

  if (parked !== undefined && delivered !== undefined) {
    if (!continues) return rebuild("diverged");

    if (delivered.at !== state.held.length) return rebuild("tail");

    if (request.key !== parked.key) return rebuild("changed");

    return { kind: "deliver", results: delivered.results, steer: delivered.steer };
  }

  if (state.busy && history.at(-1)?.role === "user") return { kind: "side" };

  if (request.aborted && history.at(-1)?.role === "toolResult") return { kind: "finish" };

  if (state.held.length === 0 || state.session === undefined) return rebuild("none");

  if (!continues) return rebuild("diverged");

  if (state.held.length === start && start < history.length) {
    return { kind: "resume", session: state.session, turn: history.slice(start) };
  }

  return rebuild("tail");
}
