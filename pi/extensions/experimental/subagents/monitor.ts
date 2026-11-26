import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export type Activity =
  | {
      kind: "phase";
      label:
        | "compacting"
        | "retrying"
        | "starting"
        | "thinking"
        | "waiting"
        | "writing";
    }
  | { kind: "tool"; label: string; target: string | undefined };

export type AgentEventListener = (event: AgentSessionEvent) => void;

const TARGET_KEYS = [
  "path",
  "file_path",
  "command",
  "pattern",
  "query",
  "url",
  "task_name",
  "target",
  "message",
];

export const callTarget = (args: unknown): string | undefined => {
  if (typeof args !== "object" || args === null) {
    return undefined;
  }

  const strings = new Map(
    Object.entries(args).flatMap(([name, value]: [string, unknown]) =>
      typeof value === "string" && value.trim() !== ""
        ? [[name, value] as const]
        : []
    )
  );

  return (
    TARGET_KEYS.map((key) => strings.get(key)).find(
      (value) => value !== undefined
    ) ?? strings.values().next().value
  );
};

const WAITING: Activity = { kind: "phase", label: "waiting" };

const RETRYING: Activity = { kind: "phase", label: "retrying" };

export interface Track {
  /** Calls in start order; Pi runs a response's tool calls in parallel. */
  executing: ReadonlyMap<string, Activity>;
  phase: Activity;
}

export const trackActivity = (track: Track): Activity =>
  [...track.executing.values()].at(-1) ?? track.phase;

const withPhase = (track: Track, phase: Activity): Track => ({
  ...track,
  phase,
});

export const nextTrack = (
  track: Track | undefined,
  event: AgentSessionEvent
): Track | undefined => {
  if (event.type === "agent_start") {
    return {
      executing: new Map(),
      phase: { kind: "phase", label: "starting" },
    };
  }

  if (event.type === "compaction_start") {
    return {
      executing: track?.executing ?? new Map(),
      phase: { kind: "phase", label: "compacting" },
    };
  }

  if (event.type === "compaction_end") {
    return { executing: track?.executing ?? new Map(), phase: WAITING };
  }

  if (event.type === "agent_end") {
    return event.willRetry
      ? { executing: new Map(), phase: RETRYING }
      : undefined;
  }

  if (event.type === "auto_retry_start") {
    return { executing: new Map(), phase: RETRYING };
  }

  if (track === undefined) {
    return undefined;
  }

  switch (event.type) {
    case "turn_start": {
      return withPhase(track, WAITING);
    }

    case "message_update": {
      if (event.message.role !== "assistant") {
        return track;
      }

      const block = event.message.content.at(-1);

      if (block?.type === "thinking") {
        return withPhase(track, { kind: "phase", label: "thinking" });
      }

      if (block?.type === "text") {
        return withPhase(track, { kind: "phase", label: "writing" });
      }

      if (block?.type === "toolCall") {
        return withPhase(track, {
          kind: "tool",
          label: block.name,
          target: callTarget(block.arguments),
        });
      }

      return track;
    }

    case "tool_execution_start": {
      return event.parentToolCallId === undefined
        ? {
            executing: new Map(track.executing).set(event.toolCallId, {
              kind: "tool",
              label: event.toolName,
              target: callTarget(event.args),
            }),
            phase: WAITING,
          }
        : track;
    }

    case "tool_execution_end": {
      if (event.parentToolCallId !== undefined) {
        return track;
      }

      const executing = new Map(track.executing);
      executing.delete(event.toolCallId);

      return { executing, phase: WAITING };
    }

    case "agent_settled":
    case "auto_retry_end":
    case "bash_execution_update":
    case "entry_appended":
    case "message_end":
    case "message_start":
    case "queue_update":
    case "session_info_changed":
    case "summarization_retry_attempt_start":
    case "summarization_retry_finished":
    case "summarization_retry_scheduled":
    case "thinking_level_changed":
    case "tool_execution_update":
    case "turn_end": {
      break;
    }
  }

  return track;
};

export class Monitor {
  readonly #followers = new Map<string, Set<AgentEventListener>>();
  readonly #listeners = new Set<() => void>();
  readonly #tracks = new Map<string, Track>();

  private readonly onError: (cause: unknown) => void;

  constructor(onError: (cause: unknown) => void) {
    this.onError = onError;
  }

  activity(path: string): Activity | undefined {
    const track = this.#tracks.get(path);

    return track === undefined ? undefined : trackActivity(track);
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  }

  follow(path: string, listener: AgentEventListener): () => void {
    const followers = this.#followers.get(path) ?? new Set();
    followers.add(listener);
    this.#followers.set(path, followers);

    return () => {
      followers.delete(listener);
    };
  }

  record(path: string, event: AgentSessionEvent): void {
    const track = nextTrack(this.#tracks.get(path), event);

    if (track === undefined) {
      this.#tracks.delete(path);
    } else {
      this.#tracks.set(path, track);
    }

    const followers = this.#followers.get(path);
    const failures: unknown[] = [];

    const followersBeforeReplacement = new Set(followers);

    for (const listener of followersBeforeReplacement) {
      try {
        listener(event);
      } catch (error) {
        followers?.delete(listener);
        failures.push(error);
      }
    }

    if (failures.length > 0) {
      throw failures[0];
    }
  }

  clear(path: string): void {
    this.#tracks.delete(path);
  }

  changed(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (error) {
        this.onError(error);
      }
    }
  }
}
