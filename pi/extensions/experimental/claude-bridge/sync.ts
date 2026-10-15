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
 *  answers. Timestamps, usage, stop reason and model fields are not part of it. Read when
 *  compared, never cached: a turn's output gains the result's text after it is recorded,
 *  and a message reloaded from disk is a copy. */
const identity = (message: Message): string =>
  JSON.stringify([
    message.role,
    message.content,
    message.role === "toolResult" ? message.toolCallId : null,
  ]);

/** How many messages from the start of `history` match `held`. Equal to `held.length`
 *  when `history` continues it. */
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
    (context.tools ?? []).map(({ name, description, parameters }) => [
      name,
      description,
      parameters,
    ]),
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
  parked?: { key: string; waiting: ReadonlySet<string> } | undefined;
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
   *  history ends in tool results and there is no turn. */
  | { kind: "rebuild"; reason: RebuildReason; priors: Message[]; turn: Message[] };

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

export function plan(state: SyncState, request: SyncRequest): Plan {
  const history = request.context.messages;
  const continues = matchedPrefix(history, state.held) === state.held.length;
  const start = turnStart(history);
  const priors = history.slice(0, start);
  const turn = history.slice(start);

  // The shape decides whose request this is; the key only whether the parked query can
  // take it.
  if (state.parked !== undefined && continues) {
    const delivered = delivery(history.slice(state.held.length), state.parked.waiting);

    if (delivered !== undefined) {
      return request.key === state.parked.key
        ? delivered
        : { kind: "rebuild", reason: "changed", priors, turn };
    }
  }

  if (state.busy && history.at(-1)?.role === "user") return { kind: "side" };

  if (request.aborted && history.at(-1)?.role === "toolResult") return { kind: "finish" };

  if (state.held.length === 0 || state.session === undefined) {
    return { kind: "rebuild", reason: "none", priors, turn };
  }

  if (!continues) return { kind: "rebuild", reason: "diverged", priors, turn };

  if (state.held.length === start && turn.length > 0) {
    return { kind: "resume", session: state.session, turn };
  }

  return { kind: "rebuild", reason: "tail", priors, turn };
}
