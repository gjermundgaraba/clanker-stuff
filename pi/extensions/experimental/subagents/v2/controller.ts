import { randomUUID } from "node:crypto";

import type {
  BuildSystemPromptOptions,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { AgentThinkingLevel, SubagentsConfig } from "../config.js";
import { resolveChildSettings, roleInstructions } from "../config.js";
import { registerContractResponder } from "../contract.js";
import type { TreeCoordinator } from "../coordinator.js";
import { forkHistory } from "../history.js";
import type { ForkTurns } from "../history.js";
import { KeyedSerialQueue } from "../keyed-queue.js";
import {
  formatV2ErrorCompletion,
  modelDeclaresV2,
  v2ChildBasePrompt,
  v2ChildCapabilityPrompt,
  v2RootPrompt,
} from "../model-contract.js";
import type { NicknamePool } from "../nicknames.js";
import { PermanentChildError } from "../permanent-error.js";
import { createChildRuntime } from "../runtime.js";
import type { ChildRuntime, ChildRuntimeFactory, ChildTurnOutcome } from "../runtime.js";
import { boundDurableText } from "../snapshot.js";
import { publicStatus } from "../status.js";
import type { PublicAgentStatus } from "../status.js";
import {
  childAgentPath,
  communicationEnvelope,
  parentAgentPath,
  resolveAgentPath,
  ROOT_AGENT_PATH,
  SUBAGENT_MESSAGE_TYPE,
  V2_TOOL_NAMES,
} from "./protocol.js";
import type { Communication, PersistedAgent, V2Snapshot } from "./protocol.js";
import { registerV2Tools } from "./tools.js";

const MAX_ERROR_LENGTH = 1000;
const V2_TOOL_SET: ReadonlySet<string> = new Set(V2_TOOL_NAMES);

type CallerContext = Pick<
  ExtensionContext,
  "cwd" | "isProjectTrusted" | "model" | "modelRegistry" | "sessionManager" | "thinkingLevel"
>;
type ToolEndpoint = Pick<ExtensionAPI, "getActiveTools">;

interface RuntimeSlot {
  api?: ExtensionAPI;
  load?: Promise<ChildRuntime>;
  runtime?: ChildRuntime;
  token: symbol;
}

interface RuntimeLease {
  runtime: ChildRuntime;
  token: symbol;
}

interface DeliveryRetry {
  attempts: number;
  permanent?: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

interface ReservationRecord {
  identity: string;
  nickname?: string;
  residency: boolean;
}

type RuntimeAgent = Pick<
  PersistedAgent,
  "agentType" | "nickname" | "path" | "sessionFile" | "status" | "tools"
>;

interface SpawnInput {
  agentType?: string;
  forkTurns: ForkTurns;
  message: string;
  model?: string;
  taskName: string;
  thinking?: AgentThinkingLevel;
}

export interface V2ControllerDependencies {
  config: SubagentsConfig;
  coordinator: TreeCoordinator;
  createRuntime?: ChildRuntimeFactory;
  dataDir: string;
  id?: () => string;
  nicknames: NicknamePool;
  onBackgroundError?: (cause: unknown) => void;
}

type WaitActivity = "aborted" | "mailbox" | "steered" | "timed_out";

const bound = (value: string, maximum: number): string =>
  value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;

const findSelectedModel = (
  selected: CallerContext["model"],
  registry: CallerContext["modelRegistry"],
) => {
  if (selected === undefined) {
    return selected;
  }
  return registry.find(selected.provider, selected.id) ?? selected;
};

const runtimeMessage = (communication: Communication) => ({
  content: communicationEnvelope(communication),
  customType: SUBAGENT_MESSAGE_TYPE,
  details: {
    communicationId: communication.id,
    from: communication.from,
    kind: communication.kind,
    to: communication.to,
  },
});

const reportFailure = async (
  operation: Promise<unknown> | undefined,
  report?: (cause: unknown) => void,
): Promise<void> => {
  try {
    await operation;
  } catch (error) {
    report?.(error);
  }
};

export class V2Controller {
  readonly #config: SubagentsConfig;
  readonly #contexts = new Map<string, CallerContext>();
  readonly #coordinator: TreeCoordinator;
  readonly #createRuntime: ChildRuntimeFactory;
  readonly #dataDir: string;
  readonly #deliveries = new Map<string, Promise<void>>();
  readonly #deliveryRetries = new Map<string, DeliveryRetry>();
  #epoch = Symbol("v2");
  readonly #id: () => string;
  readonly #mailboxSequence = new Map<string, number>();
  readonly #maxChildren: number;
  readonly #nicknames: NicknamePool;
  readonly #observedSequence = new Map<string, number>();
  readonly #onBackgroundError: ((cause: unknown) => void) | undefined;
  readonly #provisionalSpawns = new Set<Promise<null>>();
  readonly #queue = new KeyedSerialQueue();
  readonly #reservations = new Map<string, ReservationRecord>();
  readonly #slots = new Map<string, RuntimeSlot>();
  readonly #ultraAgents = new Set<string>();
  readonly #ultraInheritance = new Set<string>();
  readonly #waiters = new Map<string, Set<(activity: WaitActivity) => void>>();
  #closing = false;
  #nextSequence = 0;
  #promptOptions: BuildSystemPromptOptions | undefined;
  #rootApi: ToolEndpoint | undefined;
  #rootRunning = false;

  constructor(dependencies: V2ControllerDependencies) {
    this.#config = dependencies.config;
    this.#coordinator = dependencies.coordinator;
    this.#createRuntime = dependencies.createRuntime ?? createChildRuntime;
    this.#dataDir = dependencies.dataDir;
    this.#id = dependencies.id ?? randomUUID;
    this.#maxChildren = dependencies.config.max_concurrent_threads_per_session ?? 3;
    this.#nicknames = dependencies.nicknames;
    this.#onBackgroundError = dependencies.onBackgroundError;
  }

  setRoot(
    api: ToolEndpoint,
    promptOptions: BuildSystemPromptOptions | undefined,
    running: boolean,
  ): void {
    this.#rootApi = api;
    this.#promptOptions = promptOptions;
    this.#rootRunning = running;
  }

  async reset(): Promise<void> {
    const epoch = Symbol("v2");
    this.#closing = true;
    this.#epoch = epoch;
    this.#cancelWaiters();
    const provisionalSpawns = [...this.#provisionalSpawns];
    const slots = [...this.#slots.values()];
    this.#slots.clear();
    this.#queue.clear();
    this.#deliveries.clear();
    for (const { timer } of this.#deliveryRetries.values()) {
      clearTimeout(timer);
    }
    this.#deliveryRetries.clear();
    this.#contexts.clear();
    this.#reservations.clear();
    this.#mailboxSequence.clear();
    this.#observedSequence.clear();
    this.#ultraAgents.clear();
    this.#ultraInheritance.clear();
    this.#nextSequence = 0;
    await Promise.all([...this.#settleSlots(slots), ...provisionalSpawns]);
    if (this.#epoch === epoch) {
      this.#closing = false;
    }
  }

  attachChild(pathname: string, api: ExtensionAPI, token: symbol): void {
    const slot = this.#slots.get(pathname);
    if (slot?.token !== token) {
      throw new Error(`Stale child endpoint: ${pathname}`);
    }
    slot.api = api;
    const owns = () => this.#slots.get(pathname)?.token === token && slot.api === api;
    let collaborationEnabled = false;
    let sessionId: string | undefined;
    const unsubscribeContract = registerContractResponder(
      api,
      () =>
        sessionId === undefined
          ? undefined
          : {
              inheritedUltra: this.#ultraInheritance.has(pathname),
              nestedTools: [],
              protocol: "v2",
              sessionId,
            },
      (_ctx, ultra) => {
        this.setUltra(pathname, ultra);
        if (ultra) {
          this.#ultraInheritance.delete(pathname);
        }
      },
    );
    registerV2Tools(
      api,
      this,
      pathname,
      () => {
        if (!owns()) {
          throw new Error(`Stale child endpoint: ${pathname}`);
        }
      },
      this.#config,
    );
    const applyEligibility = (
      selected: CallerContext["model"],
      registry: CallerContext["modelRegistry"],
    ) => {
      const resolved = findSelectedModel(selected, registry);
      collaborationEnabled = modelDeclaresV2(resolved);
      const base = api.getActiveTools().filter((name) => !V2_TOOL_SET.has(name));
      api.setActiveTools(collaborationEnabled ? [...base, ...V2_TOOL_NAMES] : base);
    };
    api.on("before_agent_start", (event, ctx) => {
      let response: { systemPrompt: string } | undefined;
      if (owns()) {
        applyEligibility(ctx.model, ctx.modelRegistry);
        response = {
          systemPrompt: `${event.systemPrompt}\n\n${v2ChildCapabilityPrompt(this.#config, collaborationEnabled)}`,
        };
      }
      return response;
    });
    api.on("input", () => {
      if (owns()) {
        this.notify(pathname);
      }
    });
    api.on("session_start", (_event, ctx) => {
      if (!owns()) {
        return;
      }
      sessionId = ctx.sessionManager.getSessionId();
      applyEligibility(ctx.model, ctx.modelRegistry);
    });
    api.on("model_select", (event, ctx) => {
      if (owns()) {
        applyEligibility(event.model, ctx.modelRegistry);
      }
    });
    api.on("tool_call", () => {
      if (!owns()) {
        throw new Error(`Stale child endpoint: ${pathname}`);
      }
    });
    api.on("session_shutdown", () => {
      unsubscribeContract();
      if (slot.api === api) {
        delete slot.api;
      }
    });
  }

  rootPrompt(): string {
    return v2RootPrompt(this.#config, this.#maxChildren);
  }

  setUltra(pathname: string, enabled: boolean): void {
    if (enabled) {
      this.#ultraAgents.add(pathname);
    } else {
      this.#ultraAgents.delete(pathname);
    }
  }

  describe(): string {
    return this.list(ROOT_AGENT_PATH)
      .map(
        (agent) =>
          `${agent.path}  ${agent.status}${agent.nickname === undefined ? "" : `  ${agent.nickname}`}${agent.resident ? "  resident" : ""}`,
      )
      .join("\n");
  }

  rootDeliveries(): readonly Communication[] {
    return this.#state().communications.filter(
      (communication) => communication.to === ROOT_AGENT_PATH,
    );
  }

  async acknowledgeRoot(id: string): Promise<void> {
    await this.#removeCommunication(id);
  }

  async restore(ctx: CallerContext): Promise<void> {
    const epoch = this.#epoch;
    const abandoned = new Set(
      this.#state()
        .nodes.filter(({ status }) => status === "running")
        .map(({ path }) => path),
    );
    const pending = this.#state().nodes.filter(({ status }) => status === "pending");
    if (abandoned.size > 0 || pending.length > this.#maxChildren) {
      const interrupt = new Set(pending.slice(this.#maxChildren).map(({ path }) => path));
      await this.#coordinator.transact((draft) => {
        this.#assertEpoch(epoch);
        if (draft.protocolLatch !== "v2") {
          return;
        }
        const removed = new Set<string>();
        draft.state.nodes = draft.state.nodes.map((node) => {
          if (!abandoned.has(node.path) && !interrupt.has(node.path)) {
            return node;
          }
          if (node.status !== "pending" && node.status !== "running") {
            return node;
          }
          const { activeDeliveryId, error: _error, ...durableNode } = node;
          removed.add(activeDeliveryId);
          return {
            ...durableNode,
            status: "interrupted",
          };
        });
        draft.state.communications = draft.state.communications.filter(
          ({ id }) => !removed.has(id),
        );
      });
    }
    const communications = this.#state().communications.filter(
      (communication) => communication.to !== ROOT_AGENT_PATH,
    );
    for (const communication of communications) {
      this.#contexts.set(communication.to, ctx);
    }
    this.#drainDeliveries(epoch);
  }

  async spawn(
    caller: string,
    input: SpawnInput,
    ctx: CallerContext,
    signal?: AbortSignal,
  ): Promise<{ nickname: string; task_name: string }> {
    signal?.throwIfAborted();
    if (this.#closing) {
      throw new Error("Subagent controller is shutting down");
    }
    const epoch = this.#epoch;
    this.#requireNode(caller);
    if (input.message.trim() === "") {
      throw new Error("message must not be blank");
    }
    const completion = Promise.withResolvers<null>();
    this.#provisionalSpawns.add(completion.promise);
    try {
      const pathname = childAgentPath(caller, input.taskName);
      const reservation = await this.#reserveExecution(pathname, epoch);
      let nickname: string | undefined;
      let runtime: ChildRuntime | undefined;
      let slotToken: symbol | undefined;
      try {
        if (this.#node(pathname) !== undefined) {
          throw new Error(`Agent already exists: ${pathname}`);
        }
        nickname = this.#nicknames.choose(
          input.agentType,
          new Set([
            ...this.#coordinator.state.nicknames,
            ...[...this.#reservations.values()].flatMap((record) =>
              record.nickname === undefined ? [] : [record.nickname],
            ),
          ]),
        );
        reservation.nickname = nickname;
        const tools = this.#requireEndpoint(caller).getActiveTools();
        const settings = resolveChildSettings(
          this.#config,
          input.agentType,
          input.model,
          input.thinking,
          ctx.modelRegistry,
          ctx.model,
          ctx.thinkingLevel,
        );
        const inheritUltra =
          this.#ultraAgents.has(caller) &&
          input.thinking === undefined &&
          this.#config.roles[input.agentType ?? ""]?.thinking === undefined;
        if (inheritUltra) {
          this.#ultraAgents.add(pathname);
          this.#ultraInheritance.add(pathname);
        }
        const token = Symbol(pathname);
        slotToken = token;
        this.#slots.set(pathname, { token });
        reservation.residency = false;
        runtime = await this.#createRuntime({
          bridge: (api) => {
            this.attachChild(pathname, api, token);
            return Promise.resolve();
          },
          cwd: ctx.cwd,
          dataDir: this.#dataDir,
          history: forkHistory(ctx.sessionManager.buildContextEntries(), input.forkTurns),
          identity: pathname,
          model: settings.model,
          modelRegistry: ctx.modelRegistry,
          prompt: [v2ChildBasePrompt(this.#config, pathname, nickname), settings.instructions]
            .filter((value): value is string => Boolean(value))
            .join("\n\n"),
          promptOptions: this.#promptOptions,
          thinkingLevel: settings.thinking,
          tools,
          trusted: ctx.isProjectTrusted(),
        });
        signal?.throwIfAborted();
        const provisionalRuntime = runtime;
        const { sessionFile } = provisionalRuntime;
        const slot = this.#slots.get(pathname);
        if (slot?.token !== token) {
          throw new Error(`Stale child spawn: ${pathname}`);
        }
        slot.runtime = provisionalRuntime;
        const claimedNickname = nickname;
        const communication: Communication = {
          content: input.message,
          delivery: "turn",
          from: caller,
          id: this.#id(),
          kind: "NEW_TASK",
          to: pathname,
        };
        await this.#coordinator.transact(
          (draft) => {
            this.#assertEpoch(epoch);
            if (draft.protocolLatch !== "v2") {
              throw new Error("V2 is not active");
            }
            if (draft.state.nodes.some((node) => node.path === pathname)) {
              throw new Error(`Agent already exists: ${pathname}`);
            }
            const agentType = input.agentType === undefined ? {} : { agentType: input.agentType };
            draft.state.nodes.push({
              activeDeliveryId: communication.id,
              ...agentType,
              nickname: claimedNickname,
              path: pathname,
              sessionFile,
              status: "pending",
              tools,
            });
            draft.state.communications.push(communication);
            draft.nicknames.push(claimedNickname);
          },
          {
            onCommit: () => {
              provisionalRuntime.commit();
            },
            reserveTerminalHeadroom: true,
          },
        );
        this.#assertEpoch(epoch);
        this.#contexts.set(pathname, ctx);
        this.#scheduleDelivery(communication.id, ctx, epoch);
        return { nickname: claimedNickname, task_name: pathname };
      } catch (error) {
        if (runtime !== undefined) {
          await runtime.rollback();
        }
        if (slotToken !== undefined && this.#slots.get(pathname)?.token === slotToken) {
          this.#slots.delete(pathname);
        }
        this.#ultraAgents.delete(pathname);
        this.#ultraInheritance.delete(pathname);
        throw error;
      } finally {
        this.#releaseReservation(reservation);
        this.#drainDeliveries(epoch);
      }
    } finally {
      this.#provisionalSpawns.delete(completion.promise);
      completion.resolve(null);
    }
  }

  async sendMessage(
    caller: string,
    target: string,
    message: string,
    ctx: CallerContext,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const epoch = this.#epoch;
    if (message.trim() === "") {
      throw new Error("message must not be blank");
    }
    const resolved = resolveAgentPath(caller, target);
    await this.#serial(
      resolved,
      async () => {
        this.#requireNode(resolved);
        if (resolved !== ROOT_AGENT_PATH) {
          await this.#load(resolved, ctx, epoch);
        }
        signal?.throwIfAborted();
        const communication = await this.#publishCommunication(
          {
            content: message,
            delivery: "queue",
            from: caller,
            id: this.#id(),
            kind: "MESSAGE",
            to: resolved,
          },
          epoch,
        );
        this.#contexts.set(resolved, ctx);
        this.#scheduleDelivery(communication.id, ctx, epoch);
      },
      epoch,
    );
  }

  async followUp(
    caller: string,
    target: string,
    message: string,
    ctx: CallerContext,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const epoch = this.#epoch;
    if (message.trim() === "") {
      throw new Error("message must not be blank");
    }
    const resolved = resolveAgentPath(caller, target);
    if (resolved === ROOT_AGENT_PATH) {
      throw new Error("followup_task cannot target the root agent");
    }
    await this.#serial(
      resolved,
      async () => {
        const node = this.#requireNode(resolved);
        const runtime = this.#slots.get(resolved)?.runtime;
        const running = node.status === "running" && runtime !== undefined && runtime.isStreaming();
        if (node.status === "pending") {
          throw new Error(`Agent is already running: ${resolved}`);
        }
        if (node.status === "running" && !running) {
          throw new Error(`Agent turn is still settling: ${resolved}`);
        }
        const reservation = running ? undefined : await this.#reserveExecution(resolved, epoch);
        let lease: RuntimeLease | undefined;
        let published = false;
        try {
          lease = await this.#load(resolved, ctx, epoch, reservation);
          signal?.throwIfAborted();
          const communication: Communication = {
            content: message,
            delivery: running ? "queue" : "turn",
            from: caller,
            id: this.#id(),
            kind: "NEW_TASK",
            to: resolved,
          };
          await this.#coordinator.transact(
            (draft) => {
              this.#assertEpoch(epoch);
              if (draft.protocolLatch !== "v2") {
                return;
              }
              const targetIndex = draft.state.nodes.findIndex(({ path }) => path === resolved);
              const targetNode = draft.state.nodes[targetIndex];
              if (targetNode === undefined) {
                throw new Error(`Unknown agent: ${resolved}`);
              }
              draft.state.communications.push(communication);
              if (!running) {
                const {
                  activeDeliveryId: _activeDeliveryId,
                  error: _error,
                  ...durableNode
                } = targetNode;
                draft.state.nodes[targetIndex] = {
                  ...durableNode,
                  activeDeliveryId: communication.id,
                  status: "pending",
                };
              }
            },
            { reserveTerminalHeadroom: true },
          );
          published = true;
          this.#contexts.set(resolved, ctx);
          this.#scheduleDelivery(communication.id, ctx, epoch);
        } catch (error) {
          if (!published && lease !== undefined) {
            await this.#retire(resolved, lease.token);
          }
          throw error;
        } finally {
          if (reservation !== undefined) {
            this.#releaseReservation(reservation);
          }
        }
      },
      epoch,
    );
  }

  async interrupt(
    caller: string,
    target: string,
    signal?: AbortSignal,
  ): Promise<{ previous_status: PublicAgentStatus }> {
    signal?.throwIfAborted();
    const epoch = this.#epoch;
    const resolved = resolveAgentPath(caller, target);
    if (resolved === ROOT_AGENT_PATH || resolved === caller) {
      throw new Error("An agent cannot interrupt itself or the root agent");
    }
    return await this.#serial(
      resolved,
      async () => {
        signal?.throwIfAborted();
        const node = this.#node(resolved);
        if (node === undefined) {
          throw new Error(`Unknown agent: ${resolved}`);
        }
        const slot = this.#slots.get(resolved);
        const runtime = slot?.runtime;
        if (slot === undefined || runtime === undefined) {
          if (node.status === "pending") {
            const previous = publicStatus(node);
            await this.#coordinator.transact((draft) => {
              this.#assertEpoch(epoch);
              if (draft.protocolLatch !== "v2") {
                return;
              }
              const targetIndex = draft.state.nodes.findIndex(({ path }) => path === resolved);
              const targetNode = draft.state.nodes[targetIndex];
              if (targetNode?.status !== "pending") {
                return;
              }
              const { activeDeliveryId, error: _error, ...durableNode } = targetNode;
              draft.state.nodes[targetIndex] = {
                ...durableNode,
                status: "interrupted",
              };
              draft.state.communications = draft.state.communications.filter(
                ({ id }) => id !== activeDeliveryId,
              );
            });
            return { previous_status: previous };
          }
          return { previous_status: "not_found" };
        }
        const slotToken = slot.token;
        const previous = publicStatus(node);
        if (node.status === "pending" || node.status === "running") {
          await this.#coordinator.transact((draft) => {
            this.#assertEpoch(epoch);
            if (draft.protocolLatch !== "v2") {
              return;
            }
            const targetIndex = draft.state.nodes.findIndex(({ path }) => path === resolved);
            const targetNode = draft.state.nodes[targetIndex];
            if (targetNode?.status !== "pending" && targetNode?.status !== "running") {
              return;
            }
            const { activeDeliveryId, error: _error, ...durableNode } = targetNode;
            draft.state.nodes[targetIndex] = {
              ...durableNode,
              status: "interrupted",
            };
            draft.state.communications = draft.state.communications.filter(
              ({ id }) => id !== activeDeliveryId,
            );
          });
          try {
            await runtime.abort();
          } finally {
            await this.#retire(resolved, slotToken);
          }
        }
        return { previous_status: previous };
      },
      epoch,
    );
  }

  list(
    caller: string,
    prefix?: string,
  ): (Pick<PersistedAgent, "path" | "status"> &
    Partial<Pick<PersistedAgent, "error" | "lastAnswer" | "nickname">> & {
      resident: boolean;
    })[] {
    const resolved =
      prefix === undefined || prefix === "" ? ROOT_AGENT_PATH : resolveAgentPath(caller, prefix);
    const root = {
      error: undefined,
      lastAnswer: undefined,
      nickname: undefined,
      path: ROOT_AGENT_PATH,
      status: this.#rootRunning ? ("running" as const) : ("completed" as const),
    };
    return [root, ...this.#state().nodes]
      .filter((node) => node.path === resolved || node.path.startsWith(`${resolved}/`))
      .toSorted((left, right) => left.path.localeCompare(right.path))
      .map((node) => {
        const error = node.error === undefined ? {} : { error: node.error };
        const lastAnswer = node.lastAnswer === undefined ? {} : { lastAnswer: node.lastAnswer };
        const nickname = node.nickname === undefined ? {} : { nickname: node.nickname };
        return {
          ...error,
          ...lastAnswer,
          ...nickname,
          path: node.path,
          resident:
            node.path === ROOT_AGENT_PATH
              ? this.#rootApi !== undefined
              : this.#slots.get(node.path)?.runtime !== undefined,
          status: node.status,
        };
      });
  }

  async wait(
    caller: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ message: string; timed_out: boolean }> {
    this.#requireNode(caller);
    if (!Number.isInteger(timeoutMs)) {
      throw new TypeError("timeout_ms must be an integer");
    }
    if (timeoutMs > 3_600_000) {
      throw new Error("timeout_ms must not exceed 3600000");
    }
    signal?.throwIfAborted();
    const effective = Math.max(10_000, timeoutMs);
    const settled = Promise.withResolvers<WaitActivity>();
    const wake = (activity: WaitActivity) => {
      settled.resolve(activity);
    };
    const abort = () => {
      settled.resolve("aborted");
    };
    signal?.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.#coordinator.command(() => {
        const observed = this.#observedSequence.get(caller) ?? 0;
        const current = this.#mailboxSequence.get(caller) ?? 0;
        if (current > observed) {
          this.#observedSequence.set(caller, current);
          settled.resolve("mailbox");
          return;
        }
        const waiters = this.#waiters.get(caller) ?? new Set();
        waiters.add(wake);
        this.#waiters.set(caller, waiters);
      });
      signal?.throwIfAborted();
      timer = setTimeout(() => {
        settled.resolve("timed_out");
      }, effective);
      const result = await settled.promise;
      if (result === "aborted") {
        signal?.throwIfAborted();
        throw new Error("Wait aborted");
      }
      let message = "Wait interrupted by new input.";
      if (result === "timed_out") {
        message = "Wait timed out.";
      } else if (result === "mailbox") {
        message = "Wait completed.";
      }
      if (timeoutMs < effective) {
        message += `\n\nRequested timeout of ${timeoutMs}ms was clamped to the minimum of ${effective}ms.`;
      }
      return {
        message,
        timed_out: result === "timed_out",
      };
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      signal?.removeEventListener("abort", abort);
      this.#waiters.get(caller)?.delete(wake);
    }
  }

  notify(pathname: string): void {
    this.#wake(pathname, "steered");
  }

  mailboxEnqueued(pathname: string): void {
    this.#recordMailbox(pathname);
  }

  async shutdown(): Promise<void> {
    this.#closing = true;
    this.#epoch = Symbol("v2");
    this.#cancelWaiters();
    const provisionalSpawns = [...this.#provisionalSpawns];
    const slots = [...this.#slots.values()];
    this.#slots.clear();
    this.#queue.clear();
    this.#deliveries.clear();
    for (const { timer } of this.#deliveryRetries.values()) {
      clearTimeout(timer);
    }
    this.#deliveryRetries.clear();
    this.#contexts.clear();
    this.#reservations.clear();
    await Promise.allSettled([...this.#settleSlots(slots), ...provisionalSpawns]);
  }

  async #reserveExecution(pathname: string, epoch: symbol): Promise<ReservationRecord> {
    const reservation: ReservationRecord = {
      identity: pathname,
      residency: false,
    };
    await this.#coordinator.command(() => {
      this.#assertEpoch(epoch);
      if (this.#reservations.has(pathname)) {
        throw new Error(`Agent is already being created: ${pathname}`);
      }
      if (this.#node(pathname) !== undefined) {
        const node = this.#node(pathname);
        if (node?.status === "pending" || node?.status === "running") {
          throw new Error(`Agent is already running: ${pathname}`);
        }
      }
      const active = new Set(
        this.#state()
          .nodes.filter(({ status }) => status === "pending" || status === "running")
          .map(({ path }) => path),
      );
      const provisional = [...this.#reservations.values()].filter(
        ({ identity }) => !active.has(identity),
      ).length;
      if (active.size + provisional >= this.#maxChildren) {
        throw new Error(`Subagent execution limit reached (${this.#maxChildren})`);
      }
      if (
        !this.#slots.has(pathname) &&
        this.#slots.size + this.#residencyReservationCount() >= this.#maxChildren
      ) {
        throw new Error(`Subagent residency limit reached (${this.#maxChildren})`);
      }
      reservation.residency = !this.#slots.has(pathname);
      this.#reservations.set(pathname, reservation);
    });
    return reservation;
  }

  #releaseReservation(reservation: ReservationRecord): void {
    if (this.#reservations.get(reservation.identity) === reservation) {
      this.#reservations.delete(reservation.identity);
    }
  }

  #residencyReservationCount(): number {
    return [...this.#reservations.values()].filter(({ residency }) => residency).length;
  }

  async #publishCommunication(communication: Communication, epoch: symbol): Promise<Communication> {
    await this.#coordinator.transact(
      (draft) => {
        this.#assertEpoch(epoch);
        if (draft.protocolLatch !== "v2") {
          throw new Error("V2 is not active");
        }
        draft.state.communications.push(communication);
      },
      { reserveTerminalHeadroom: true },
    );
    return communication;
  }

  #scheduleDelivery(id: string, ctx: CallerContext, epoch: symbol = this.#epoch): void {
    const communication = this.#communication(id);
    if (communication !== undefined) {
      this.#contexts.set(communication.to, ctx);
      const retry = this.#deliveryRetries.get(communication.to);
      if (retry?.timer !== undefined) {
        clearTimeout(retry.timer);
      }
      this.#deliveryRetries.delete(communication.to);
    }
    this.#drainDeliveries(epoch);
  }

  #drainDeliveries(epoch: symbol = this.#epoch): void {
    if (epoch !== this.#epoch) {
      return;
    }
    const plannedTargets = new Set(this.#slots.keys());
    const activeTargets = new Set(
      [...this.#deliveries.keys()].flatMap((id) => {
        const target = this.#communication(id)?.to;
        return target === undefined ? [] : [target];
      }),
    );
    let capacity = this.#maxChildren - this.#slots.size - this.#residencyReservationCount();
    for (const communication of this.#state().communications) {
      if (
        communication.to === ROOT_AGENT_PATH ||
        this.#deliveryRetries.get(communication.to)?.timer !== undefined ||
        this.#deliveryRetries.get(communication.to)?.permanent === true ||
        activeTargets.has(communication.to) ||
        this.#deliveries.has(communication.id)
      ) {
        continue;
      }
      const context = this.#contexts.get(communication.to);
      if (context === undefined) {
        continue;
      }
      if (!plannedTargets.has(communication.to)) {
        if (capacity <= 0) {
          continue;
        }
        plannedTargets.add(communication.to);
        capacity -= 1;
      }
      const delivery = this.#deliver(communication.id, context, epoch);
      this.#deliveries.set(communication.id, delivery);
      activeTargets.add(communication.to);
      void this.#observeDelivery(communication.id, communication.to, delivery, epoch);
    }
  }

  async #observeDelivery(
    id: string,
    target: string,
    delivery: Promise<void>,
    epoch: symbol,
  ): Promise<void> {
    try {
      await delivery;
      const retry = this.#deliveryRetries.get(target);
      if (retry?.timer !== undefined) {
        clearTimeout(retry.timer);
      }
      this.#deliveryRetries.delete(target);
    } catch (error) {
      this.#onBackgroundError?.(error);
      if (error instanceof PermanentChildError) {
        this.#deliveryRetries.set(target, { attempts: 1, permanent: true });
        return;
      }
      const attempts = (this.#deliveryRetries.get(target)?.attempts ?? 0) + 1;
      const timer = setTimeout(
        () => {
          const retry = this.#deliveryRetries.get(target);
          if (retry?.timer !== timer || epoch !== this.#epoch) {
            return;
          }
          retry.timer = undefined;
          this.#drainDeliveries(epoch);
        },
        Math.min(250 * 2 ** (attempts - 1), 30_000),
      );
      timer.unref();
      this.#deliveryRetries.set(target, { attempts, timer });
    } finally {
      if (this.#deliveries.get(id) === delivery) {
        this.#deliveries.delete(id);
      }
      this.#drainDeliveries(epoch);
    }
  }

  async #deliver(id: string, ctx: CallerContext, epoch: symbol): Promise<void> {
    this.#assertEpoch(epoch);
    const communication = this.#communication(id);
    if (communication === undefined || communication.to === ROOT_AGENT_PATH) {
      return;
    }
    if (communication.delivery === "turn") {
      const active = await this.#serial(
        communication.to,
        async () => {
          const current = this.#communication(id);
          let started:
            | {
                current: Communication;
                lease: RuntimeLease;
                turn: ReturnType<ChildRuntime["startTurn"]>;
              }
            | undefined;
          if (current !== undefined) {
            const lease = await this.#load(current.to, ctx, epoch);
            let turn;
            try {
              turn = lease.runtime.startTurn({
                text: communicationEnvelope(current),
              });
              await turn.accepted;
            } catch (error) {
              try {
                await this.#finishError(current.to, id, error, epoch);
              } finally {
                await this.#retire(current.to, lease.token);
              }
              return started;
            }
            try {
              await this.#acceptTurn(current, epoch);
            } catch (error) {
              try {
                await lease.runtime.abort();
              } finally {
                await this.#retire(current.to, lease.token);
              }
              throw error;
            }
            started = { current, lease, turn };
          }
          return started;
        },
        epoch,
      );
      if (active === undefined) {
        return;
      }
      void this.#observeTurn(active, id, epoch);
      return;
    }
    const active = await this.#serial(
      communication.to,
      async () => {
        const current = this.#communication(id);
        if (current === undefined) {
          return null;
        }
        const lease = await this.#load(current.to, ctx, epoch);
        try {
          const delivered = lease.runtime.sendMessage(
            runtimeMessage(current),
            () => {
              this.#recordMailbox(current.to);
            },
            current.kind === "NEW_TASK",
          );
          await delivered.accepted;
          if (delivered.settled !== undefined) {
            await this.#acceptTurn(current, epoch);
            return {
              current,
              lease,
              turn: {
                accepted: Promise.resolve(),
                settled: delivered.settled,
              },
            };
          }
        } catch (error) {
          await this.#retire(current.to, lease.token);
          throw error;
        }
        await this.#removeCommunication(id, epoch);
        const node = this.#node(current.to);
        if (node !== undefined && node.status !== "pending" && node.status !== "running") {
          await this.#retire(current.to, lease.token);
        }
        return null;
      },
      epoch,
    );
    if (active !== null) {
      void this.#observeTurn(active, id, epoch);
    }
  }

  async #observeTurn(
    active: {
      current: Communication;
      lease: RuntimeLease;
      turn: ReturnType<ChildRuntime["startTurn"]>;
    },
    deliveryId: string,
    epoch: symbol,
  ): Promise<void> {
    try {
      const final = await active.turn.settled;
      await this.#serial(
        active.current.to,
        () => this.#finish(active.current.to, deliveryId, final, active.lease.token, epoch),
        epoch,
      );
    } catch (error) {
      try {
        await this.#serial(
          active.current.to,
          async () => {
            const ownsDelivery = await this.#finishError(
              active.current.to,
              deliveryId,
              error,
              epoch,
            );
            if (ownsDelivery) {
              await this.#retire(active.current.to, active.lease.token);
            }
          },
          epoch,
        );
      } catch (publicationError) {
        this.#onBackgroundError?.(publicationError);
      }
    }
  }

  async #acceptTurn(communication: Communication, epoch: symbol): Promise<void> {
    await this.#coordinator.transact((draft) => {
      this.#assertEpoch(epoch);
      if (draft.protocolLatch !== "v2") {
        throw new Error("V2 is not active");
      }
      const nodeIndex = draft.state.nodes.findIndex(({ path }) => path === communication.to);
      const node = draft.state.nodes[nodeIndex];
      if (
        node === undefined ||
        !draft.state.communications.some(({ id }) => id === communication.id) ||
        (communication.delivery === "turn" && node.activeDeliveryId !== communication.id)
      ) {
        throw new Error(`Stale V2 turn delivery: ${communication.id}`);
      }
      const { activeDeliveryId: _activeDeliveryId, error: _error, ...durableNode } = node;
      draft.state.nodes[nodeIndex] = {
        ...durableNode,
        activeDeliveryId: communication.id,
        status: "running",
      };
      draft.state.communications = draft.state.communications.filter(
        ({ id }) => id !== communication.id,
      );
    });
    this.#recordMailbox(communication.to);
  }

  async #finish(
    pathname: string,
    deliveryId: string,
    final: ChildTurnOutcome,
    slotToken: symbol,
    epoch: symbol,
  ): Promise<void> {
    let ownsDelivery = false;
    try {
      if (final.status === "errored") {
        ownsDelivery = await this.#finishError(pathname, deliveryId, final.error, epoch);
        return;
      }
      let completionId: string | undefined;
      ownsDelivery = await this.#coordinator.transact((draft) => {
        this.#assertEpoch(epoch);
        if (draft.protocolLatch !== "v2") {
          return false;
        }
        const nodeIndex = draft.state.nodes.findIndex(({ path }) => path === pathname);
        const node = draft.state.nodes[nodeIndex];
        if (node?.activeDeliveryId !== deliveryId) {
          return false;
        }
        const { activeDeliveryId: _activeDeliveryId, error: _error, ...durableNode } = node;
        if (final.status === "interrupted") {
          draft.state.nodes[nodeIndex] = {
            ...durableNode,
            status: "interrupted",
          };
          return true;
        }
        const lastAnswer = final.text === undefined ? undefined : boundDurableText(final.text);
        const { lastAnswer: _lastAnswer, ...completedNode } = durableNode;
        const answer = lastAnswer === undefined ? {} : { lastAnswer };
        draft.state.nodes[nodeIndex] = {
          ...completedNode,
          ...answer,
          status: "completed",
        };
        const parent = parentAgentPath(pathname);
        if (parent !== undefined) {
          completionId = this.#id();
          draft.state.communications.push({
            content: lastAnswer ?? "",
            delivery: "queue",
            from: pathname,
            id: completionId,
            kind: "FINAL_ANSWER",
            to: parent,
          });
        }
        return true;
      });
      if (completionId !== undefined) {
        const parent = parentAgentPath(pathname);
        const context =
          parent === undefined
            ? undefined
            : (this.#contexts.get(parent) ?? this.#contexts.get(pathname));
        if (parent !== ROOT_AGENT_PATH && context !== undefined) {
          this.#scheduleDelivery(completionId, context, epoch);
        }
      }
    } finally {
      if (ownsDelivery) {
        await this.#retire(pathname, slotToken);
      }
    }
  }

  async #finishError(
    pathname: string,
    deliveryId: string,
    cause: unknown,
    epoch: symbol,
  ): Promise<boolean> {
    const message = bound(cause instanceof Error ? cause.message : String(cause), MAX_ERROR_LENGTH);
    let completionId: string | undefined;
    const ownsDelivery = await this.#coordinator.transact((draft) => {
      this.#assertEpoch(epoch);
      if (draft.protocolLatch !== "v2") {
        return false;
      }
      const nodeIndex = draft.state.nodes.findIndex(({ path }) => path === pathname);
      const node = draft.state.nodes[nodeIndex];
      if (node?.activeDeliveryId !== deliveryId) {
        return false;
      }
      const {
        activeDeliveryId: _activeDeliveryId,
        error: _error,
        lastAnswer: _lastAnswer,
        ...durableNode
      } = node;
      draft.state.nodes[nodeIndex] = {
        ...durableNode,
        error: message,
        status: "errored",
      };
      draft.state.communications = draft.state.communications.filter(({ id }) => id !== deliveryId);
      const parent = parentAgentPath(pathname);
      if (parent !== undefined) {
        completionId = this.#id();
        draft.state.communications.push({
          content: formatV2ErrorCompletion(message),
          delivery: "queue",
          from: pathname,
          id: completionId,
          kind: "FINAL_ANSWER",
          to: parent,
        });
      }
      return true;
    });
    if (completionId !== undefined) {
      const parent = parentAgentPath(pathname);
      const context =
        parent === undefined
          ? undefined
          : (this.#contexts.get(parent) ?? this.#contexts.get(pathname));
      if (parent !== ROOT_AGENT_PATH && context !== undefined) {
        this.#scheduleDelivery(completionId, context, epoch);
      }
    }
    return ownsDelivery;
  }

  async #load(
    pathname: string,
    ctx: CallerContext,
    epoch: symbol,
    residencyReservation?: ReservationRecord,
  ): Promise<RuntimeLease> {
    this.#assertEpoch(epoch);
    this.#requireNode(pathname);
    let slot = this.#slots.get(pathname);
    if (slot?.runtime !== undefined) {
      if (residencyReservation !== undefined) {
        residencyReservation.residency = false;
      }
      return { runtime: slot.runtime, token: slot.token };
    }
    if (slot === undefined) {
      const otherReservations =
        this.#residencyReservationCount() -
        (residencyReservation !== undefined &&
        this.#reservations.get(residencyReservation.identity) === residencyReservation &&
        residencyReservation.residency
          ? 1
          : 0);
      if (this.#slots.size + otherReservations >= this.#maxChildren) {
        throw new Error(`Subagent residency limit reached (${this.#maxChildren})`);
      }
      slot = { token: Symbol(pathname) };
      this.#slots.set(pathname, slot);
    }
    if (residencyReservation !== undefined) {
      residencyReservation.residency = false;
    }
    if (slot.load === undefined) {
      const { token } = slot;
      slot.load = (async () => {
        const current = this.#requireNode(pathname);
        const runtime = await this.#createRuntime({
          bridge: (api) => {
            this.attachChild(pathname, api, token);
            return Promise.resolve();
          },
          cwd: ctx.cwd,
          dataDir: this.#dataDir,
          history: [],
          identity: pathname,
          model: undefined,
          modelRegistry: ctx.modelRegistry,
          prompt: [
            v2ChildBasePrompt(this.#config, pathname, current.nickname ?? pathname),
            roleInstructions(this.#config, current.agentType),
          ]
            .filter((value): value is string => Boolean(value))
            .join("\n\n"),
          promptOptions: this.#promptOptions,
          sessionFile: current.sessionFile,
          tools: current.tools,
          trusted: ctx.isProjectTrusted(),
        });
        if (epoch !== this.#epoch || this.#slots.get(pathname)?.token !== token) {
          await runtime.dispose();
          throw new Error(`Stale child runtime load: ${pathname}`);
        }
        slot.runtime = runtime;
        return runtime;
      })();
    }
    try {
      const runtime = await slot.load;
      this.#assertEpoch(epoch);
      return { runtime, token: slot.token };
    } catch (error) {
      if (this.#slots.get(pathname) === slot && slot.runtime === undefined) {
        this.#slots.delete(pathname);
      }
      throw error;
    } finally {
      if (this.#slots.get(pathname) === slot) {
        slot.load = undefined;
      }
    }
  }

  async #retire(pathname: string, token: symbol | undefined): Promise<void> {
    if (pathname === "") {
      return;
    }
    const slot = this.#slots.get(pathname);
    if (slot === undefined || (token !== undefined && slot.token !== token)) {
      return;
    }
    try {
      await slot.runtime?.dispose();
    } finally {
      if (this.#slots.get(pathname)?.token === slot.token) {
        this.#slots.delete(pathname);
        this.#drainDeliveries();
      }
    }
  }

  #settleSlots(slots: readonly RuntimeSlot[]): Promise<void>[] {
    return slots.flatMap((slot) => {
      if (slot.runtime !== undefined) {
        return [reportFailure(slot.runtime.dispose(), this.#onBackgroundError)];
      }
      if (slot.load !== undefined) {
        return [reportFailure(slot.load)];
      }
      return [];
    });
  }

  async #removeCommunication(id: string, epoch: symbol = this.#epoch): Promise<void> {
    await this.#coordinator.transact((draft) => {
      this.#assertEpoch(epoch);
      if (draft.protocolLatch !== "v2") {
        return;
      }
      draft.state.communications = draft.state.communications.filter((item) => item.id !== id);
    });
  }

  #recordMailbox(pathname: string): void {
    this.#nextSequence += 1;
    this.#mailboxSequence.set(pathname, this.#nextSequence);
    const waiters = this.#waiters.get(pathname);
    if (waiters !== undefined && waiters.size > 0) {
      this.#observedSequence.set(pathname, this.#nextSequence);
      for (const wake of waiters) {
        wake("mailbox");
      }
    }
  }

  #wake(pathname: string, activity: WaitActivity): void {
    for (const wake of this.#waiters.get(pathname) ?? []) {
      wake(activity);
    }
  }

  #cancelWaiters(): void {
    for (const waiters of this.#waiters.values()) {
      for (const wake of waiters) {
        wake("steered");
      }
    }
    this.#waiters.clear();
  }

  #requireEndpoint(pathname: string): ToolEndpoint {
    const api = pathname === ROOT_AGENT_PATH ? this.#rootApi : this.#slots.get(pathname)?.api;
    if (api === undefined) {
      throw new Error(`Agent endpoint is not resident: ${pathname}`);
    }
    return api;
  }

  #requireNode(pathname: string): RuntimeAgent {
    if (pathname === ROOT_AGENT_PATH) {
      return {
        nickname: "root",
        path: ROOT_AGENT_PATH,
        sessionFile: "<root>",
        status: this.#rootRunning ? "running" : "completed",
        tools: [],
      };
    }
    const node = this.#node(pathname);
    if (node === undefined) {
      throw new Error(`Unknown agent: ${pathname}`);
    }
    return node;
  }

  #node(pathname: string): PersistedAgent | undefined {
    return this.#state().nodes.find((node) => node.path === pathname);
  }

  #communication(id: string): Communication | undefined {
    return this.#state().communications.find((item) => item.id === id);
  }

  #state(): Readonly<V2Snapshot> {
    const snapshot = this.#coordinator.state;
    if (snapshot.protocolLatch !== "v2") {
      throw new Error("V2 is not active");
    }
    return snapshot.state;
  }

  #assertEpoch(epoch: symbol): void {
    if (epoch !== this.#epoch) {
      throw new Error("Stale V2 controller operation");
    }
  }

  async #serial<T>(
    key: string,
    operation: () => Promise<T>,
    epoch: symbol = this.#epoch,
  ): Promise<T> {
    return await this.#queue.run(key, async () => {
      this.#assertEpoch(epoch);
      if (this.#closing) {
        throw new Error("Subagent controller is shutting down");
      }
      return await operation();
    });
  }
}
