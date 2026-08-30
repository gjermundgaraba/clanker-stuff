import { existsSync } from "node:fs";
import { setImmediate as yieldImmediate } from "node:timers/promises";

import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import type { SubagentsConfig } from "./config.js";
import { registerContractResponder } from "./contract.js";
import type { NestedToolContract } from "./contract.js";
import { TreeCoordinator } from "./coordinator.js";
import { NicknamePool } from "./nicknames.js";
import { resolveProtocol } from "./selection.js";
import type { Protocol } from "./selection.js";
import { createControlStore, freshSnapshot, rootBinding } from "./snapshot.js";
import type { ControlStore, RootBinding } from "./snapshot.js";
import { TranscriptCursor } from "./transcript.js";
import { V1Controller, V1_NOTIFICATION_TYPE } from "./v1/controller.js";
import { V1_TOOL_NAMES } from "./v1/protocol.js";
import { registerV1Tools } from "./v1/tools.js";
import { V2Controller } from "./v2/controller.js";
import { ROOT_AGENT_PATH, SUBAGENT_MESSAGE_TYPE, V2_TOOL_NAMES } from "./v2/protocol.js";
import { registerV2Tools } from "./v2/tools.js";

const ALL_TOOL_NAMES: ReadonlySet<string> = new Set([...V1_TOOL_NAMES, ...V2_TOOL_NAMES]);
const RootDeliveryDetailsSchema = Type.Object(
  {
    communicationId: Type.Optional(Type.String()),
    notificationId: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

const currentModel = (
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
): Model<Api> | undefined => {
  const selected = ctx.model;
  if (selected === undefined) {
    return undefined;
  }
  return ctx.modelRegistry.find(selected.provider, selected.id) ?? selected;
};

export interface SubagentManagerOptions {
  config: SubagentsConfig;
  configError?: string;
  dataDir: string;
}

interface RootAttempt {
  id: string;
  protocol: "v1" | "v2";
}

type SessionPhase =
  | {
      kind: "awaiting-session";
      protocol: Protocol;
    }
  | {
      kind: "selectable";
      protocol: Protocol;
      sessionId: string;
    }
  | {
      kind: "restore-pending";
      protocol: Protocol;
      sessionId: string;
    }
  | {
      kind: "locked";
      protocol: Protocol;
      sessionId: string;
    }
  | {
      error: Error;
      kind: "start-failed";
      protocol: Protocol;
      sessionId: string;
    };

export class SubagentManager {
  readonly #config: SubagentsConfig;
  readonly #configError: string | undefined;
  readonly #coordinator = new TreeCoordinator();
  readonly #dataDir: string;
  readonly #nicknames: NicknamePool;
  readonly #pi: ExtensionAPI;
  #promptOptions: BeforeAgentStartEvent["systemPromptOptions"] | undefined;
  #rootAttempt: RootAttempt | undefined;
  #rootCursor: TranscriptCursor | undefined;
  #rootDeliveryTail: Promise<void> = Promise.resolve();
  #rootRunning = false;
  #rootSessionManager: ExtensionContext["sessionManager"] | undefined;
  #shuttingDown = false;
  #sessionPhase: SessionPhase = {
    kind: "awaiting-session",
    protocol: "v1",
  };
  #showBackgroundError: ((cause: unknown) => void) | undefined;
  readonly #unsubscribeContract: ReturnType<typeof registerContractResponder>;
  readonly #unsubscribeState: () => void;
  readonly #v1: V1Controller;
  #v1Definitions: readonly NestedToolContract[] = [];
  readonly #v2: V2Controller;

  constructor(pi: ExtensionAPI, options: SubagentManagerOptions) {
    this.#config = options.config;
    this.#configError = options.configError;
    this.#dataDir = options.dataDir;
    this.#pi = pi;
    this.#nicknames = new NicknamePool(options.config);
    const report = (cause: unknown) => this.#showBackgroundError?.(cause);
    this.#v1 = new V1Controller({
      config: options.config,
      coordinator: this.#coordinator,
      dataDir: options.dataDir,
      nicknames: this.#nicknames,
      onBackgroundError: report,
    });
    this.#v2 = new V2Controller({
      config: options.config,
      coordinator: this.#coordinator,
      dataDir: options.dataDir,
      nicknames: this.#nicknames,
      onBackgroundError: report,
    });
    this.#unsubscribeState = this.#coordinator.subscribe(() => {
      this.#scheduleRootDelivery();
      if (this.#coordinator.error !== undefined) {
        this.#showBackgroundError?.(this.#coordinator.error);
      }
    });
    this.#unsubscribeContract = registerContractResponder(
      pi,
      () => {
        const phase = this.#sessionPhase;
        return phase.kind === "awaiting-session"
          ? undefined
          : {
              nestedTools: phase.protocol === "v1" ? this.#v1Definitions : [],
              protocol: phase.protocol,
              sessionId: phase.sessionId,
            };
      },
      (ctx, ultra) => {
        this.#refreshProtocol(ctx);
        if (ultra !== undefined) {
          this.#v2.setUltra(ROOT_AGENT_PATH, ultra);
        }
      },
    );
  }

  async start(event: SessionStartEvent, ctx: ExtensionContext): Promise<void> {
    this.#shuttingDown = true;
    await this.#rootDeliveryTail;
    this.#rootDeliveryTail = Promise.resolve();
    this.#shuttingDown = false;
    this.#showBackgroundError = (error) => {
      ctx.ui.notify(
        `Subagent controller background failure: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    };
    this.#rootAttempt = undefined;
    this.#rootRunning = false;
    this.#rootCursor = undefined;
    this.#rootSessionManager = ctx.sessionManager;
    const sessionId = ctx.sessionManager.getSessionId();
    this.#sessionPhase = {
      kind: "selectable",
      protocol: this.#sessionPhase.protocol,
      sessionId,
    };
    if (this.#configError !== undefined) {
      ctx.ui.notify(this.#configError, "warning");
    }
    const binding = rootBinding(
      ctx.sessionManager.getSessionId(),
      ctx.sessionManager.getSessionFile(),
    );
    try {
      const store = createControlStore(this.#dataDir, binding);
      const stored = await store.load();
      const inherited = stored?.protocolLatch ?? (await this.#forkProtocol(event, ctx));
      const selected = resolveProtocol(currentModel(ctx), this.#config.protocols, inherited);
      const restore = stored !== undefined && stored.protocolLatch === selected;
      if (stored !== undefined && !restore) {
        ctx.ui.notify(
          `Configured subagent protocol ${selected.toUpperCase()} overrides the stored ${stored.protocolLatch.toUpperCase()} tree protocol; starting a new tree.`,
          "warning",
        );
      }
      const state = restore ? stored : freshSnapshot(selected, binding);
      let kind: "locked" | "restore-pending" | "selectable" = "locked";
      if (restore && selected !== "off") {
        kind = "restore-pending";
      } else if (inherited === undefined) {
        kind = "selectable";
      }
      this.#sessionPhase = {
        kind,
        protocol: selected,
        sessionId,
      };
      await Promise.all([this.#v1.reset(), this.#v2.reset()]);
      this.#ensureRootCursor();
      await this.#coordinator.install(store, state, restore || inherited !== undefined);
      this.#applyTools();
      this.#syncRoot();
      this.#scheduleRootDelivery();
    } catch (error) {
      const startError = error instanceof Error ? error : new Error(String(error));
      this.#sessionPhase = {
        error: startError,
        kind: "start-failed",
        protocol: resolveProtocol(currentModel(ctx), this.#config.protocols),
        sessionId,
      };
      ctx.ui.notify(
        `Unable to open subagent control state; collaboration is blocked: ${startError.message}`,
        "warning",
      );
      this.#applyTools();
    }
  }

  async beforeAgentStart(event: BeforeAgentStartEvent, ctx: ExtensionContext) {
    this.#refreshProtocol(ctx);
    this.#assertHealthy();
    if (this.#sessionPhase.kind === "selectable") {
      const { protocol, sessionId } = this.#sessionPhase;
      const binding = rootBinding(
        ctx.sessionManager.getSessionId(),
        ctx.sessionManager.getSessionFile(),
      );
      await this.#coordinator.install(
        createControlStore(this.#dataDir, binding),
        freshSnapshot(protocol, binding),
        true,
      );
      this.#sessionPhase = {
        kind: "locked",
        protocol,
        sessionId,
      };
    }
    this.#promptOptions = event.systemPromptOptions;
    this.#syncRoot();
    this.#scheduleRootDelivery();
    if (this.#sessionPhase.kind === "restore-pending") {
      const { protocol, sessionId } = this.#sessionPhase;
      this.#sessionPhase = {
        kind: "locked",
        protocol,
        sessionId,
      };
      if (protocol === "v1") {
        await this.#v1.restore(ctx);
      }
      if (protocol === "v2") {
        await this.#v2.restore(ctx);
      }
    }
    let prompt = "";
    if (this.#sessionPhase.protocol === "v1") {
      prompt = this.#v1.rootPrompt();
    } else if (this.#sessionPhase.protocol === "v2") {
      prompt = this.#v2.rootPrompt();
    }
    return prompt === "" ? undefined : { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
  }

  agentStart(): void {
    this.#rootRunning = true;
    this.#syncRoot();
  }

  agentSettled(): void {
    this.#rootRunning = false;
    this.#syncRoot();
    this.#scheduleRootDelivery();
  }

  input(): void {
    if (this.#sessionPhase.protocol === "v2") {
      this.#v2.notify(ROOT_AGENT_PATH);
    }
    this.#scheduleRootDelivery();
  }

  async modelSelect(event: { model: Model<Api> }, ctx: ExtensionContext): Promise<void> {
    const selected = resolveProtocol(
      currentModel({ model: event.model, modelRegistry: ctx.modelRegistry }) ?? event.model,
      this.#config.protocols,
    );
    if (this.#isProtocolLocked()) {
      if (selected !== this.#sessionPhase.protocol) {
        ctx.ui.notify(
          `Subagent protocol is locked to ${this.#sessionPhase.protocol.toUpperCase()} for this tree; model selection did not change its tools.`,
          "warning",
        );
      }
      return;
    }
    if (selected === this.#sessionPhase.protocol) {
      return;
    }
    const binding = rootBinding(
      ctx.sessionManager.getSessionId(),
      ctx.sessionManager.getSessionFile(),
    );
    await this.#coordinator.installProvisional(
      createControlStore(this.#dataDir, binding),
      freshSnapshot(selected, binding),
      () => {
        this.#selectProtocol(selected);
      },
    );
    this.#applyTools();
  }

  toolCall(event: ToolCallEvent): { block: true; reason: string } | undefined {
    if (!ALL_TOOL_NAMES.has(event.toolName)) {
      return undefined;
    }
    try {
      this.#assertHealthy();
      return undefined;
    } catch (error) {
      return {
        block: true,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  toolResult(event: ToolResultEvent):
    | {
        content: { text: string; type: "text" }[];
        details: { error: string };
        isError: true;
      }
    | undefined {
    if (!ALL_TOOL_NAMES.has(event.toolName)) {
      return undefined;
    }
    try {
      this.#assertHealthy();
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ text: message, type: "text" }],
        details: { error: message },
        isError: true,
      };
    }
  }

  describe(): string {
    if (this.#sessionPhase.protocol === "off") {
      return "Subagents are disabled for the current model.";
    }
    return `${this.#isProtocolLocked() ? "locked" : "unlocked"} ${this.#sessionPhase.protocol.toUpperCase()}\n${this.#sessionPhase.protocol === "v1" ? this.#v1.describe() : this.#v2.describe()}`;
  }

  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    this.#unsubscribeContract();
    this.#unsubscribeState();
    this.#showBackgroundError = undefined;
    await this.#rootDeliveryTail;
    if (this.#sessionPhase.protocol === "v1") {
      await this.#v1.shutdown();
    }
    if (this.#sessionPhase.protocol === "v2") {
      await this.#v2.shutdown();
    }
  }

  #assertHealthy(): void {
    const error =
      this.#sessionPhase.kind === "start-failed"
        ? this.#sessionPhase.error
        : this.#coordinator.error;
    if (error !== undefined) {
      throw new Error(
        `Subagent state could not be persisted: ${error.message}. Collaboration is blocked for this tree.`,
        { cause: error },
      );
    }
  }

  #latch(protocol: "v1" | "v2", ctx: ExtensionContext): void {
    this.#refreshProtocol(ctx);
    if (this.#sessionPhase.protocol !== protocol) {
      throw new Error(`${protocol.toUpperCase()} tools are not active`);
    }
    this.#assertHealthy();
  }

  #refreshProtocol(ctx: Pick<ExtensionContext, "model" | "modelRegistry">): void {
    if (this.#isProtocolLocked()) {
      return;
    }
    const selected = resolveProtocol(currentModel(ctx), this.#config.protocols);
    if (selected !== this.#sessionPhase.protocol) {
      this.#selectProtocol(selected);
      this.#applyTools();
    }
  }

  #isProtocolLocked(): boolean {
    return this.#sessionPhase.kind === "locked" || this.#sessionPhase.kind === "restore-pending";
  }

  #selectProtocol(protocol: Protocol): void {
    this.#sessionPhase = { ...this.#sessionPhase, protocol };
  }

  #applyTools(): void {
    if (this.#sessionPhase.protocol === "v1") {
      this.#v1Definitions = registerV1Tools(
        this.#pi,
        this.#v1,
        (ctx) => {
          this.#latch("v1", ctx);
        },
        this.#config,
      );
    } else if (this.#sessionPhase.protocol === "v2") {
      registerV2Tools(
        this.#pi,
        this.#v2,
        ROOT_AGENT_PATH,
        (ctx) => {
          this.#latch("v2", ctx);
        },
        this.#config,
      );
    }
    const base = this.#pi.getActiveTools().filter((name) => !ALL_TOOL_NAMES.has(name));
    let selected: readonly string[] = [];
    if (this.#sessionPhase.protocol === "v1") {
      selected = V1_TOOL_NAMES;
    } else if (this.#sessionPhase.protocol === "v2") {
      selected = V2_TOOL_NAMES;
    }
    this.#pi.setActiveTools([...base, ...selected]);
  }

  #syncRoot(): void {
    this.#v1.setRoot(this.#pi, this.#promptOptions, this.#rootRunning);
    this.#v2.setRoot(this.#pi, this.#promptOptions, this.#rootRunning);
  }

  #scheduleRootDelivery(): void {
    if (this.#shuttingDown) {
      return;
    }
    const previous = this.#rootDeliveryTail;
    this.#rootDeliveryTail = (async () => {
      try {
        await previous;
        if (this.#shuttingDown) {
          return;
        }
        await (this.#rootAttempt === undefined
          ? this.#deliverRootOnce()
          : this.#verifyRootAttempt());
      } catch (error) {
        this.#showBackgroundError?.(error);
      }
    })();
  }

  async #deliverRootOnce(): Promise<void> {
    if (this.#rootAttempt !== undefined || this.#sessionPhase.kind === "awaiting-session") {
      return;
    }
    const v1 = this.#sessionPhase.protocol === "v1" ? this.#v1.rootDeliveries()[0] : undefined;
    const v2 = this.#sessionPhase.protocol === "v2" ? this.#v2.rootDeliveries()[0] : undefined;
    let attempt: RootAttempt | undefined;
    if (v1 !== undefined) {
      attempt = { id: v1.id, protocol: "v1" };
    }
    if (v2 !== undefined) {
      attempt = { id: v2.id, protocol: "v2" };
    }
    if (attempt === undefined) {
      return;
    }
    const existingEntryId = this.#rootEntryId(attempt);
    if (existingEntryId !== undefined) {
      const session = this.#rootSessionManager;
      const sessionFile = session?.getSessionFile();
      if (
        session !== undefined &&
        sessionFile !== undefined &&
        !SessionManager.open(sessionFile, session.getSessionDir(), session.getCwd())
          .getEntries()
          .some(({ id }) => id === existingEntryId)
      ) {
        throw new Error(
          `Root delivery ${attempt.id} exists only in memory; its transcript append failed`,
        );
      }
      await this.#acknowledgeRoot(attempt);
      this.#scheduleRootDelivery();
      return;
    }
    this.#ensureRootCursor();
    this.#rootAttempt = attempt;
    if (v1 !== undefined) {
      this.#pi.sendMessage(
        {
          content: v1.content,
          customType: V1_NOTIFICATION_TYPE,
          details: { agentId: v1.agentId, notificationId: v1.id },
          display: false,
        },
        { deliverAs: "steer", triggerTurn: this.#rootRunning },
      );
    } else if (v2 !== undefined) {
      this.#pi.sendMessage(
        {
          content: `Message Type: ${v2.kind}\nTask name: ${v2.to}\nSender: ${v2.from}\nPayload:\n${v2.content}`,
          customType: SUBAGENT_MESSAGE_TYPE,
          details: {
            communicationId: v2.id,
            from: v2.from,
            kind: v2.kind,
            to: v2.to,
          },
          display: false,
        },
        { deliverAs: "steer", triggerTurn: this.#rootRunning },
      );
      this.#v2.mailboxEnqueued(ROOT_AGENT_PATH);
    }
    await yieldImmediate();
    await this.#verifyRootAttempt();
  }

  async #verifyRootAttempt(): Promise<void> {
    const attempt = this.#rootAttempt;
    if (attempt === undefined) {
      return;
    }
    const entryId = this.#rootEntryId(attempt);
    this.#ensureRootCursor();
    if (
      this.#rootSessionManager?.getSessionFile() !== undefined &&
      this.#rootCursor === undefined
    ) {
      return;
    }
    if (this.#rootCursor !== undefined) {
      if (entryId === undefined) {
        return;
      }
      await this.#rootCursor.verify(entryId);
    }
    await this.#acknowledgeRoot(attempt);
    if (this.#rootAttempt === attempt) {
      this.#rootAttempt = undefined;
    }
    this.#scheduleRootDelivery();
  }

  async #acknowledgeRoot(attempt: RootAttempt): Promise<void> {
    if (attempt.protocol === "v1") {
      await this.#v1.acknowledgeRoot(attempt.id);
      return;
    }
    await this.#v2.acknowledgeRoot(attempt.id);
  }

  #rootEntryId(attempt: RootAttempt): string | undefined {
    const session = this.#rootSessionManager;
    if (session === undefined) {
      return undefined;
    }
    return session.getBranch().findLast((entry) => {
      if (
        entry.type !== "custom_message" ||
        !Value.Check(RootDeliveryDetailsSchema, entry.details)
      ) {
        return false;
      }
      return attempt.protocol === "v1"
        ? "notificationId" in entry.details && entry.details.notificationId === attempt.id
        : "communicationId" in entry.details && entry.details.communicationId === attempt.id;
    })?.id;
  }

  #ensureRootCursor(): void {
    if (this.#rootCursor !== undefined) {
      return;
    }
    const rootFile = this.#rootSessionManager?.getSessionFile();
    if (rootFile !== undefined && existsSync(rootFile)) {
      this.#rootCursor = new TranscriptCursor(rootFile, false);
    }
  }

  async #forkProtocol(
    event: SessionStartEvent,
    ctx: ExtensionContext,
  ): Promise<Protocol | undefined> {
    if (event.reason !== "fork" || event.previousSessionFile === undefined) {
      return undefined;
    }
    try {
      const source = SessionManager.open(event.previousSessionFile, undefined, ctx.cwd);
      const binding: RootBinding = rootBinding(source.getSessionId(), event.previousSessionFile);
      const store: ControlStore = createControlStore(this.#dataDir, binding);
      const stored = await store.load();
      return stored?.protocolLatch;
    } catch (error) {
      ctx.ui.notify(
        `Unable to inherit the source subagent protocol for this fork: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
      return undefined;
    }
  }
}
