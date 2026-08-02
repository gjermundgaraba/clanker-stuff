import { contentText } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  convertToLlm,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const SIDE_SYSTEM_PROMPT = `You are in a multi-turn side conversation forked from the main Pi session.

Treat inherited messages as reference context only. The main session continues independently; do not continue or take ownership of its unfinished work unless the side user explicitly asks you to analyze it.`;

const SIDE_BOUNDARY = `Side conversation boundary.

Everything before this message is a frozen snapshot of the main conversation. It is reference context, not an instruction to continue the main agent's work. Respond only to messages after this boundary.`;

export type SideTranscriptItem =
  | { kind: "assistant"; message: AssistantMessage }
  | { kind: "error"; text: string }
  | {
      id: string;
      kind: "tool";
      name: string;
      status: "done" | "error" | "running";
    }
  | { kind: "user"; text: string };

export interface SideConversationState {
  isRunning: boolean;
  statusMessage?: string;
  streamingMessage?: AssistantMessage;
  transcript: SideTranscriptItem[];
}

type ParentSession = Pick<SessionManager, "getEntries" | "getLeafId">;
type SessionMessage = ReturnType<
  typeof buildSessionContext
>["messages"][number];

export const stableSnapshotMessages = (
  messages: readonly SessionMessage[]
): ReturnType<typeof convertToLlm> => {
  const completedToolCalls = new Set(
    messages
      .filter(
        (message): message is Extract<SessionMessage, { role: "toolResult" }> =>
          message.role === "toolResult"
      )
      .map((message) => message.toolCallId)
  );

  const incompleteAssistantIndex = messages.findIndex(
    (message) =>
      message.role === "assistant" &&
      message.content.some(
        (part) => part.type === "toolCall" && !completedToolCalls.has(part.id)
      )
  );

  const stable =
    incompleteAssistantIndex === -1
      ? [...messages]
      : messages.slice(0, incompleteAssistantIndex);
  return convertToLlm(structuredClone(stable));
};

export const createSideSessionManager = (
  parent: ParentSession,
  cwd: string
): SessionManager => {
  const side = SessionManager.inMemory(cwd);

  for (const message of stableSnapshotMessages(
    buildSessionContext(parent.getEntries(), parent.getLeafId()).messages
  )) {
    side.appendMessage(message);
  }
  side.appendMessage({
    content: SIDE_BOUNDARY,
    role: "user",
    timestamp: Date.now(),
  });
  return side;
};

export class SideSessionController {
  readonly state: SideConversationState = {
    isRunning: false,
    transcript: [],
  };

  private readonly listeners = new Set<() => void>();
  private readonly session: AgentSession;
  private disposePromise?: Promise<void>;
  private disposed = false;
  private unsubscribe?: () => void;

  constructor(session: AgentSession) {
    this.session = session;
    this.state.isRunning = session.isStreaming;
    this.unsubscribe = session.subscribe((event) => {
      this.handleEvent(event);
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  submit(text: string): boolean {
    const prompt = text.trim();
    if (!prompt || this.disposed) {
      return false;
    }
    if (this.state.isRunning) {
      return false;
    }

    this.state.transcript.push({ kind: "user", text: prompt });
    this.state.isRunning = true;
    this.state.statusMessage = undefined;
    this.notify();

    void this.runPrompt(prompt);
    return true;
  }

  latestAssistantText(): string | undefined {
    const item = this.state.transcript.findLast(
      (
        candidate
      ): candidate is Extract<SideTranscriptItem, { kind: "assistant" }> =>
        candidate.kind === "assistant" &&
        contentText(candidate.message.content).trim().length > 0
    );
    return item ? contentText(item.message.content).trim() : undefined;
  }

  dispose(): Promise<void> {
    this.disposePromise ??= (async () => {
      this.disposed = true;
      try {
        if (this.session.isStreaming) {
          await this.session.abort();
        }
      } catch {
        // Disposal must continue after an abort failure.
      }
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      this.listeners.clear();
      this.session.dispose();
    })();
    return this.disposePromise;
  }

  private handleEvent(event: AgentSessionEvent): void {
    // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- Other session events do not affect side conversation state.
    switch (event.type) {
      case "agent_start": {
        this.state.isRunning = true;
        this.state.statusMessage = undefined;
        break;
      }
      case "agent_settled": {
        this.state.isRunning = false;
        break;
      }
      case "message_update": {
        if (event.message.role === "assistant") {
          this.state.streamingMessage = event.message;
        }
        break;
      }
      case "message_end": {
        if (event.message.role === "assistant") {
          this.state.transcript.push({
            kind: "assistant",
            message: event.message,
          });
          this.state.streamingMessage = undefined;
          if (event.message.stopReason === "error") {
            this.state.statusMessage =
              event.message.errorMessage ?? "Side response failed.";
          }
        }
        break;
      }
      case "tool_execution_start": {
        this.state.transcript.push({
          id: event.toolCallId,
          kind: "tool",
          name: event.toolName,
          status: "running",
        });
        break;
      }
      case "tool_execution_end": {
        const tool = this.state.transcript.find(
          (item): item is Extract<SideTranscriptItem, { kind: "tool" }> =>
            item.kind === "tool" && item.id === event.toolCallId
        );
        if (tool) {
          tool.status = event.isError ? "error" : "done";
        }
        break;
      }
      case "auto_retry_start": {
        this.state.statusMessage = `Retrying side response (${event.attempt}/${event.maxAttempts})…`;
        break;
      }
      case "auto_retry_end": {
        this.state.statusMessage = event.success ? undefined : event.finalError;
        break;
      }
      case "compaction_start": {
        this.state.statusMessage = "Compacting side context…";
        break;
      }
      case "compaction_end": {
        this.state.statusMessage = event.errorMessage;
        break;
      }
      default: {
        break;
      }
    }
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private async runPrompt(prompt: string): Promise<void> {
    try {
      await this.session.prompt(prompt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state.transcript.push({ kind: "error", text: message });
      this.state.statusMessage = message;
      this.state.isRunning = false;
      this.notify();
    }
  }
}

export const createSideConversation = async (
  ctx: ExtensionContext,
  thinkingLevel: ModelThinkingLevel
): Promise<SideSessionController> => {
  const settingsManager = SettingsManager.create(ctx.cwd, getAgentDir(), {
    projectTrusted: ctx.isProjectTrusted(),
  });
  const resourceLoader = new DefaultResourceLoader({
    agentDir: getAgentDir(),
    appendSystemPrompt: [SIDE_SYSTEM_PROMPT],
    cwd: ctx.cwd,
    settingsManager,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    agentDir: getAgentDir(),
    cwd: ctx.cwd,
    model: ctx.model,
    resourceLoader,
    sessionManager: createSideSessionManager(ctx.sessionManager, ctx.cwd),
    settingsManager,
    thinkingLevel,
  });
  await session.bindExtensions({ mode: ctx.mode, uiContext: ctx.ui });
  return new SideSessionController(session);
};
