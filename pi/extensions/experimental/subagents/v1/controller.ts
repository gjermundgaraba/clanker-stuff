import { randomUUID } from "node:crypto";

import type {
  BuildSystemPromptOptions,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { AgentThinkingLevel, SubagentsConfig } from "../config.js";
import { resolveChildSettings, roleInstructions } from "../config.js";
import type { TreeCoordinator } from "../coordinator.js";
import { forkHistory } from "../history.js";
import { KeyedSerialQueue } from "../keyed-queue.js";
import { v1ChildPrompt, v1RootPrompt } from "../model-contract.js";
import type { NicknamePool } from "../nicknames.js";
import { PermanentChildError } from "../permanent-error.js";
import { createChildRuntime } from "../runtime.js";
import type {
  ChildRuntime,
  ChildRuntimeFactory,
  ChildTurnOutcome,
  PromptInput,
} from "../runtime.js";
import { boundDurableText } from "../snapshot.js";
import { publicStatus } from "../status.js";
import type { PublicAgentStatus } from "../status.js";
import { prepareInput } from "./input.js";
import type { V1InputItem } from "./input.js";
import { isFinalStatus, V1_TOOL_NAMES } from "./protocol.js";
import type {
  V1Notification,
  V1PersistedAgent,
  V1Snapshot,
  V1Turn,
} from "./protocol.js";

const DEFAULT_MAX_OPEN_AGENTS = 6;
const MAX_ERROR_LENGTH = 1000;
export const V1_NOTIFICATION_TYPE = "subagent-notification";

type CallerContext = Pick<
  ExtensionContext,
  | "cwd"
  | "isProjectTrusted"
  | "model"
  | "modelRegistry"
  | "sessionManager"
  | "thinkingLevel"
>;

type RuntimeState =
  | { kind: "vacant" }
  | { kind: "loading"; promise: Promise<ChildRuntime> }
  | { kind: "ready"; runtime: ChildRuntime };

interface RuntimeOwner {
  context?: CallerContext;
  state: RuntimeState;
}

export interface V1ControllerDependencies {
  config: SubagentsConfig;
  coordinator: TreeCoordinator;
  createRuntime?: ChildRuntimeFactory;
  dataDir: string;
  id?: () => string;
  nicknames: NicknamePool;
  onBackgroundError?: (error: unknown) => void;
}

interface SpawnInput {
  agentType?: string;
  forkContext: boolean;
  items?: readonly V1InputItem[];
  message?: string;
  model?: string;
  thinking?: AgentThinkingLevel;
}

interface SendInput {
  interrupt: boolean;
  items?: readonly V1InputItem[];
  message?: string;
}

const bound = (value: string, maximum: number): string =>
  value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;

type OpenAgent = Extract<V1PersistedAgent, { edge: "open" }>;

const agentIdentity = (agent: V1PersistedAgent) => ({
  id: agent.id,
  nickname: agent.nickname,
  ...(agent.role === undefined ? {} : { role: agent.role }),
  sessionFile: agent.sessionFile,
  tools: agent.tools,
});

const retainedAnswer = (agent: V1PersistedAgent) =>
  agent.lastAnswer === undefined ? {} : { lastAnswer: agent.lastAnswer };

const pendingAgent = (
  agent: V1PersistedAgent,
  active: V1Turn,
  queue: V1Turn[]
): Extract<V1PersistedAgent, { status: "pending" }> => ({
  ...agentIdentity(agent),
  ...retainedAnswer(agent),
  active: { ...active, phase: "pending" },
  edge: "open",
  queue,
  status: "pending",
});

const runningAgent = (
  agent: V1PersistedAgent,
  active: V1Turn,
  queue: V1Turn[]
): Extract<V1PersistedAgent, { status: "running" }> => ({
  ...agentIdentity(agent),
  ...retainedAnswer(agent),
  active: { ...active, phase: "running" },
  edge: "open",
  queue,
  status: "running",
});

const interruptedAgent = (
  agent: V1PersistedAgent,
  queue: V1Turn[],
  keepAnswer = true
): Extract<V1PersistedAgent, { status: "interrupted" }> => ({
  ...agentIdentity(agent),
  ...(keepAnswer ? retainedAnswer(agent) : {}),
  edge: "open",
  queue,
  status: "interrupted",
});

const completedAgent = (
  agent: V1PersistedAgent,
  queue: V1Turn[],
  answer?: string
): Extract<V1PersistedAgent, { status: "completed" }> => ({
  ...agentIdentity(agent),
  ...(answer === undefined ? {} : { lastAnswer: boundDurableText(answer) }),
  edge: "open",
  queue,
  status: "completed",
});

const erroredAgent = (
  agent: V1PersistedAgent,
  queue: V1Turn[],
  error: string,
  keepAnswer: boolean
): Extract<V1PersistedAgent, { status: "errored" }> => ({
  ...agentIdentity(agent),
  ...(keepAnswer ? retainedAnswer(agent) : {}),
  edge: "open",
  error: bound(error, MAX_ERROR_LENGTH),
  queue,
  status: "errored",
});

const shutdownAgent = (
  agent: V1PersistedAgent
): Extract<V1PersistedAgent, { status: "shutdown" }> => ({
  ...agentIdentity(agent),
  ...retainedAnswer(agent),
  edge: "closed",
  queue: [],
  status: "shutdown",
});

const applyFinal = (
  agent: OpenAgent,
  final: ChildTurnOutcome,
  queue: V1Turn[]
): OpenAgent => {
  switch (final.status) {
    case "errored": {
      return erroredAgent(agent, queue, final.error, false);
    }
    case "interrupted": {
      return interruptedAgent(agent, queue, false);
    }
    case "completed": {
      return completedAgent(agent, queue, final.text);
    }
    default: {
      final satisfies never;
      throw new Error("Unknown child outcome");
    }
  }
};

const reportFailure = async (
  operation: Promise<unknown> | undefined,
  report?: (error: unknown) => void
): Promise<void> => {
  try {
    await operation;
  } catch (error) {
    report?.(error);
  }
};

export class V1Controller {
  readonly #config: SubagentsConfig;
  readonly #coordinator: TreeCoordinator;
  readonly #createRuntime: ChildRuntimeFactory;
  readonly #dataDir: string;
  #epoch = Symbol("v1");
  readonly #id: () => string;
  readonly #maxOpenAgents: number;
  readonly #nicknames: NicknamePool;
  readonly #nicknameReservations = new Map<string, symbol>();
  readonly #onBackgroundError: ((error: unknown) => void) | undefined;
  readonly #openReservations = new Map<symbol, string>();
  readonly #provisionalSpawns = new Set<Promise<null>>();
  readonly #queue = new KeyedSerialQueue();
  readonly #runtimeOwners = new Map<string, RuntimeOwner>();
  readonly #waiters = new Map<string, Set<() => void>>();
  #closing = false;
  #promptOptions: BuildSystemPromptOptions | undefined;
  #rootApi: ExtensionAPI | undefined;

  constructor(dependencies: V1ControllerDependencies) {
    this.#config = dependencies.config;
    this.#coordinator = dependencies.coordinator;
    this.#createRuntime = dependencies.createRuntime ?? createChildRuntime;
    this.#dataDir = dependencies.dataDir;
    this.#id = dependencies.id ?? randomUUID;
    this.#maxOpenAgents =
      dependencies.config.max_concurrent_threads_per_session ??
      DEFAULT_MAX_OPEN_AGENTS;
    this.#nicknames = dependencies.nicknames;
    this.#onBackgroundError = dependencies.onBackgroundError;
  }

  setRoot(
    api: ExtensionAPI,
    promptOptions: BuildSystemPromptOptions | undefined,
    _running: boolean
  ): void {
    this.#rootApi = api;
    this.#promptOptions = promptOptions;
  }

  async reset(): Promise<void> {
    const epoch = Symbol("v1");
    this.#closing = true;
    this.#epoch = epoch;
    this.#cancelWaiters();
    const provisionalSpawns = [...this.#provisionalSpawns];
    const runtimeOperations = this.#takeRuntimeOperations();
    this.#queue.clear();
    this.#nicknameReservations.clear();
    this.#openReservations.clear();
    await Promise.all([...runtimeOperations, ...provisionalSpawns]);
    if (this.#epoch === epoch) {
      this.#closing = false;
    }
  }

  rootPrompt(): string {
    return v1RootPrompt(this.#config, this.#maxOpenAgents);
  }

  describe(): string {
    return (
      this.#state()
        .agents.toSorted((left, right) => left.id.localeCompare(right.id))
        .map(
          (agent) =>
            `${agent.id}  ${agent.nickname}  ${agent.status}  ${agent.edge}${this.#runtimeOwners.get(agent.id)?.state.kind === "ready" ? "  resident" : ""}`
        )
        .join("\n") || "No V1 agents"
    );
  }

  rootDeliveries(): readonly V1Notification[] {
    return this.#state().notifications;
  }

  async acknowledgeRoot(id: string): Promise<void> {
    await this.#coordinator.transact((draft) => {
      if (draft.protocolLatch !== "v1") {
        return;
      }
      draft.state.notifications = draft.state.notifications.filter(
        (notification) => notification.id !== id
      );
    });
  }

  async restore(ctx: CallerContext): Promise<void> {
    const epoch = this.#epoch;
    const openBefore = this.#state().agents.filter(
      (agent) => agent.edge === "open"
    );
    const abandoned = new Set(
      openBefore
        .filter((agent) => agent.active?.phase === "running")
        .map(({ id }) => id)
    );
    if (abandoned.size > 0 || openBefore.length > this.#maxOpenAgents) {
      const keep = new Set(
        openBefore.slice(0, this.#maxOpenAgents).map(({ id }) => id)
      );
      await this.#coordinator.transact((draft) => {
        this.#assertEpoch(epoch);
        if (draft.protocolLatch !== "v1") {
          return;
        }
        for (const [index, current] of draft.state.agents.entries()) {
          let agent = current;
          if (abandoned.has(agent.id)) {
            agent = interruptedAgent(agent, agent.queue);
          }
          if (agent.edge === "open" && !keep.has(agent.id)) {
            agent = shutdownAgent(agent);
          }
          draft.state.agents[index] = agent;
        }
      });
    }
    const agents = this.#state().agents.filter(
      (agent) => agent.edge === "open"
    );
    await Promise.all(
      agents.map((agent) => this.#restoreAgent(agent, ctx, epoch))
    );
  }

  async spawn(
    input: SpawnInput,
    ctx: CallerContext,
    signal?: AbortSignal
  ): Promise<{ agent_id: string; nickname: string }> {
    signal?.throwIfAborted();
    if (this.#closing) {
      throw new Error("Subagent controller is shutting down");
    }
    const epoch = this.#epoch;
    const completion = Promise.withResolvers<null>();
    this.#provisionalSpawns.add(completion.promise);
    try {
      const id = this.#id();
      const reservation = await this.#reserveOpenSlot(id, epoch);
      let nickname: string | undefined;
      let runtime: ChildRuntime | undefined;
      try {
        nickname = this.#nicknames.choose(
          input.agentType,
          new Set([
            ...this.#coordinator.state.nicknames,
            ...this.#nicknameReservations.keys(),
          ])
        );
        this.#nicknameReservations.set(nickname, reservation);
        const prepared = await this.#prepare(input, ctx);
        this.#assertEpoch(epoch);
        signal?.throwIfAborted();
        const settings = resolveChildSettings(
          this.#config,
          input.agentType,
          input.model,
          input.thinking,
          ctx.modelRegistry,
          ctx.model,
          ctx.thinkingLevel
        );
        const tools = this.#rootTools();
        runtime = await this.#createRuntime({
          bridge: () => Promise.resolve(),
          cwd: ctx.cwd,
          dataDir: this.#dataDir,
          history: input.forkContext
            ? forkHistory(ctx.sessionManager.buildContextEntries(), "all")
            : [],
          identity: id,
          model: settings.model,
          modelRegistry: ctx.modelRegistry,
          prompt: [
            v1ChildPrompt(this.#config, id, nickname),
            settings.instructions,
          ]
            .filter((value): value is string => Boolean(value))
            .join("\n\n"),
          promptOptions: this.#promptOptions,
          thinkingLevel: settings.thinking,
          tools,
          trusted: ctx.isProjectTrusted(),
        });
        const provisionalRuntime = runtime;
        const { sessionFile } = provisionalRuntime;
        this.#assertEpoch(epoch);
        signal?.throwIfAborted();
        const claimedNickname = nickname;
        const turn: V1Turn = {
          id: randomUUID(),
          input: prepared,
        };
        await this.#coordinator.transact(
          (draft) => {
            this.#assertEpoch(epoch);
            if (draft.protocolLatch !== "v1") {
              throw new Error("V1 is not active");
            }
            if (draft.state.agents.some((agent) => agent.id === id)) {
              throw new Error(`Agent already exists: ${id}`);
            }
            draft.state.agents.push({
              active: { ...turn, phase: "pending" },
              edge: "open" as const,
              id,
              nickname: claimedNickname,
              queue: [],
              ...(input.agentType === undefined
                ? {}
                : { role: input.agentType }),
              sessionFile,
              status: "pending" as const,
              tools,
            });
            draft.nicknames.push(claimedNickname);
          },
          {
            onCommit: () => {
              provisionalRuntime.commit();
            },
            reserveTerminalHeadroom: true,
          }
        );
        this.#assertEpoch(epoch);
        this.#runtimeOwners.set(id, {
          context: ctx,
          state: { kind: "ready", runtime: provisionalRuntime },
        });
        this.#scheduleDelivery(id, ctx, epoch);
        return { agent_id: id, nickname: claimedNickname };
      } catch (error) {
        await runtime?.rollback();
        throw error;
      } finally {
        this.#openReservations.delete(reservation);
        if (
          nickname !== undefined &&
          this.#nicknameReservations.get(nickname) === reservation
        ) {
          this.#nicknameReservations.delete(nickname);
        }
      }
    } finally {
      this.#provisionalSpawns.delete(completion.promise);
      completion.resolve(null);
    }
  }

  async sendInput(
    target: string,
    input: SendInput,
    ctx: CallerContext,
    signal?: AbortSignal
  ): Promise<{ submission_id: string }> {
    signal?.throwIfAborted();
    const epoch = this.#epoch;
    const submissionId = randomUUID();
    await this.#serial(
      target,
      async () => {
        const prepared = await this.#prepare(input, ctx);
        this.#assertEpoch(epoch);
        signal?.throwIfAborted();
        const turn: V1Turn = {
          id: submissionId,
          input: prepared,
        };
        const before = this.#agent(target);
        if (before === undefined || before.edge === "closed") {
          throw new Error(`Agent is not open: ${target}`);
        }
        const runtime = await this.#load(target, ctx, false, epoch);
        this.#assertEpoch(epoch);
        signal?.throwIfAborted();
        if (input.interrupt && before.active !== undefined) {
          await runtime.abort();
          this.#assertEpoch(epoch);
        }
        signal?.throwIfAborted();
        await this.#coordinator.transact(
          (draft) => {
            signal?.throwIfAborted();
            this.#assertEpoch(epoch);
            if (draft.protocolLatch !== "v1") {
              throw new Error("V1 is not active");
            }
            const index = draft.state.agents.findIndex(
              ({ id }) => id === target
            );
            const agent = draft.state.agents[index];
            if (agent === undefined || agent.edge === "closed") {
              throw new Error(`Agent is not open: ${target}`);
            }
            if (input.interrupt || agent.active === undefined) {
              draft.state.agents[index] = pendingAgent(
                agent,
                turn,
                agent.queue
              );
            } else {
              agent.queue.push(turn);
            }
          },
          { reserveTerminalHeadroom: true }
        );
        this.#scheduleDelivery(target, ctx, epoch);
      },
      epoch
    );
    return { submission_id: submissionId };
  }

  async resume(
    id: string,
    ctx: CallerContext,
    signal?: AbortSignal
  ): Promise<{ status: PublicAgentStatus }> {
    signal?.throwIfAborted();
    const epoch = this.#epoch;
    const exists = this.#agent(id);
    if (exists === undefined) {
      return { status: "not_found" };
    }
    await this.#serial(
      id,
      async () => {
        const agent = this.#agent(id);
        if (agent?.edge === "open") {
          return;
        }
        const reservation = await this.#reserveOpenSlot(id, epoch);
        let loaded = false;
        try {
          await this.#load(id, ctx, true, epoch);
          loaded = true;
          signal?.throwIfAborted();
          await this.#coordinator.transact((draft) => {
            this.#assertEpoch(epoch);
            if (draft.protocolLatch !== "v1") {
              throw new Error("V1 is not active");
            }
            const index = draft.state.agents.findIndex(
              (candidate) => candidate.id === id
            );
            const target = draft.state.agents[index];
            if (target === undefined) {
              throw new Error(`Unknown agent: ${id}`);
            }
            draft.state.agents[index] = interruptedAgent(target, []);
          });
        } catch (error) {
          if (loaded) {
            await this.#retire(id);
          }
          throw error;
        } finally {
          this.#openReservations.delete(reservation);
        }
      },
      epoch
    );
    return { status: publicStatus(this.#agent(id)) };
  }

  async close(
    target: string,
    _ctx: CallerContext,
    signal?: AbortSignal
  ): Promise<{ previous_status: PublicAgentStatus }> {
    signal?.throwIfAborted();
    const epoch = this.#epoch;
    return await this.#serial(
      target,
      async () => {
        signal?.throwIfAborted();
        const previous = publicStatus(this.#agent(target));
        if (previous === "not_found") {
          return { previous_status: previous };
        }
        await this.#coordinator.transact((draft) => {
          this.#assertEpoch(epoch);
          if (draft.protocolLatch !== "v1") {
            throw new Error("V1 is not active");
          }
          const index = draft.state.agents.findIndex(({ id }) => id === target);
          const agent = draft.state.agents[index];
          if (agent === undefined || agent.edge === "closed") {
            return;
          }
          draft.state.agents[index] = shutdownAgent(agent);
        });
        const owner = this.#runtimeOwners.get(target);
        this.#runtimeOwners.delete(target);
        try {
          if (owner?.state.kind === "ready") {
            await owner.state.runtime.abort();
            await owner.state.runtime.dispose();
          }
        } catch (error) {
          this.#onBackgroundError?.(error);
        }
        this.#notifyWaiters(target);
        return { previous_status: previous };
      },
      epoch
    );
  }

  async wait(
    targets: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<{
    status: Record<string, PublicAgentStatus>;
    timed_out: boolean;
  }> {
    if (!Number.isInteger(timeoutMs)) {
      throw new TypeError("timeout_ms must be an integer");
    }
    if (timeoutMs <= 0) {
      throw new Error("timeout_ms must be greater than zero");
    }
    const effective = Math.min(3_600_000, Math.max(10_000, timeoutMs));
    signal?.throwIfAborted();
    const collect = () =>
      Object.fromEntries(
        targets.flatMap((id) => {
          const agent = this.#agent(id);
          return agent === undefined || isFinalStatus(agent.status)
            ? [[id, publicStatus(agent)] as const]
            : [];
        })
      );
    const immediate = collect();
    if (Object.keys(immediate).length > 0) {
      return { status: immediate, timed_out: false };
    }
    const settled = Promise.withResolvers<"aborted" | "status" | "timeout">();
    const wake = () => {
      settled.resolve("status");
    };
    const abort = () => {
      settled.resolve("aborted");
    };
    signal?.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.#coordinator.command(() => {
        const status = collect();
        if (Object.keys(status).length > 0) {
          settled.resolve("status");
          return;
        }
        for (const id of targets) {
          const set = this.#waiters.get(id) ?? new Set();
          set.add(wake);
          this.#waiters.set(id, set);
        }
      });
      signal?.throwIfAborted();
      timer = setTimeout(() => {
        settled.resolve("timeout");
      }, effective);
      const outcome = await settled.promise;
      if (outcome === "aborted") {
        signal?.throwIfAborted();
        throw new Error("Wait aborted");
      }
      const status = collect();
      return {
        status,
        timed_out: outcome === "timeout" && Object.keys(status).length === 0,
      };
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      signal?.removeEventListener("abort", abort);
      for (const id of targets) {
        this.#waiters.get(id)?.delete(wake);
      }
    }
  }

  async shutdown(): Promise<void> {
    this.#closing = true;
    this.#epoch = Symbol("v1");
    this.#cancelWaiters();
    const provisionalSpawns = [...this.#provisionalSpawns];
    const runtimeOperations = this.#takeRuntimeOperations();
    this.#queue.clear();
    this.#nicknameReservations.clear();
    this.#openReservations.clear();
    await Promise.allSettled([...runtimeOperations, ...provisionalSpawns]);
  }

  async #prepare(
    input: Pick<SpawnInput, "items" | "message">,
    ctx: CallerContext
  ): Promise<PromptInput> {
    return await prepareInput(
      input.message,
      input.items,
      ctx.cwd,
      this.#promptOptions?.skills ?? [],
      ctx.isProjectTrusted()
    );
  }

  async #reserveOpenSlot(id: string, epoch: symbol): Promise<symbol> {
    const reservation = Symbol("v1-open");
    await this.#coordinator.command(() => {
      this.#assertEpoch(epoch);
      const open = new Set(
        this.#state()
          .agents.filter(({ edge }) => edge === "open")
          .map((agent) => agent.id)
      );
      const provisional = [...this.#openReservations.values()].filter(
        (reservedId) => !open.has(reservedId)
      ).length;
      if (open.size + provisional >= this.#maxOpenAgents) {
        throw new Error(`V1 open-agent limit reached (${this.#maxOpenAgents})`);
      }
      this.#openReservations.set(reservation, id);
    });
    return reservation;
  }

  #rootTools(): string[] {
    if (this.#rootApi === undefined) {
      throw new Error("The V1 root endpoint is not attached");
    }
    const v1ToolNames: ReadonlySet<string> = new Set(V1_TOOL_NAMES);
    return this.#rootApi
      .getActiveTools()
      .filter((name) => !v1ToolNames.has(name));
  }

  async #load(
    id: string,
    ctx: CallerContext,
    allowClosed: boolean,
    epoch: symbol
  ): Promise<ChildRuntime> {
    this.#assertEpoch(epoch);
    const current = this.#agent(id);
    if (current === undefined || (!allowClosed && current.edge === "closed")) {
      throw new Error(`Agent is not open: ${id}`);
    }
    let owner = this.#runtimeOwners.get(id);
    if (owner === undefined) {
      owner = { context: ctx, state: { kind: "vacant" } };
      this.#runtimeOwners.set(id, owner);
    } else {
      owner.context = ctx;
    }
    if (owner.state.kind === "ready") {
      return owner.state.runtime;
    }
    if (owner.state.kind === "vacant") {
      const claimedOwner = owner;
      const promise = (async () => {
        const agent = this.#agent(id);
        if (agent === undefined) {
          throw new Error(`Unknown agent: ${id}`);
        }
        const runtime = await this.#createRuntime({
          bridge: () => Promise.resolve(),
          cwd: ctx.cwd,
          dataDir: this.#dataDir,
          history: [],
          identity: id,
          model: undefined,
          modelRegistry: ctx.modelRegistry,
          prompt: [
            v1ChildPrompt(this.#config, id, agent.nickname),
            roleInstructions(this.#config, agent.role),
          ]
            .filter((value): value is string => Boolean(value))
            .join("\n\n"),
          promptOptions: this.#promptOptions,
          sessionFile: agent.sessionFile,
          tools: agent.tools,
          trusted: ctx.isProjectTrusted(),
        });
        if (
          epoch !== this.#epoch ||
          this.#runtimeOwners.get(id) !== claimedOwner ||
          claimedOwner.state.kind !== "loading"
        ) {
          await runtime.dispose();
          throw new Error(`Stale V1 runtime load: ${id}`);
        }
        claimedOwner.state = { kind: "ready", runtime };
        return runtime;
      })();
      owner.state = { kind: "loading", promise };
    }
    const loading = owner.state;
    try {
      const runtime = await loading.promise;
      this.#assertEpoch(epoch);
      return runtime;
    } catch (error) {
      if (this.#runtimeOwners.get(id) === owner && owner.state === loading) {
        owner.state = { kind: "vacant" };
      }
      throw error;
    }
  }

  #scheduleDelivery(
    id: string,
    ctx: CallerContext,
    epoch: symbol = this.#epoch
  ): void {
    const started = this.#serial(
      id,
      async () => {
        const agent = this.#agent(id);
        const turn = agent?.active;
        let active:
          | {
              attemptId: string;
              childTurn: ReturnType<ChildRuntime["startTurn"]>;
            }
          | undefined;
        if (
          agent !== undefined &&
          agent.edge !== "closed" &&
          turn !== undefined &&
          turn.phase === "pending"
        ) {
          const runtime = await this.#load(id, ctx, false, epoch);
          const attemptId = turn.id;
          const childTurn = runtime.startTurn(turn.input);
          await childTurn.accepted;
          try {
            await this.#coordinator.transact((draft) => {
              this.#assertEpoch(epoch);
              if (draft.protocolLatch !== "v1") {
                return;
              }
              const index = draft.state.agents.findIndex(
                (candidate) => candidate.id === id
              );
              if (
                index === -1 ||
                draft.state.agents[index]?.status !== "pending" ||
                draft.state.agents[index].active.id !== attemptId
              ) {
                return;
              }
              const target = draft.state.agents[index];
              draft.state.agents[index] = runningAgent(
                target,
                target.active,
                target.queue
              );
            });
          } catch (error) {
            try {
              await runtime.abort();
            } finally {
              await this.#retire(id);
            }
            throw error;
          }
          active = { attemptId, childTurn };
        }
        return active;
      },
      epoch
    );
    void this.#observeDelivery(id, started, epoch);
  }

  async #finish(
    id: string,
    attemptId: string,
    final: ChildTurnOutcome,
    epoch: symbol
  ): Promise<void> {
    let hasNext = false;
    await this.#coordinator.transact((draft) => {
      this.#assertEpoch(epoch);
      if (draft.protocolLatch !== "v1") {
        return;
      }
      const index = draft.state.agents.findIndex(
        (candidate) => candidate.id === id
      );
      const agent = draft.state.agents[index];
      if (
        agent === undefined ||
        agent.edge !== "open" ||
        agent.active?.id !== attemptId
      ) {
        return;
      }
      const [next, ...queue] = agent.queue;
      let settled = applyFinal(agent, final, queue);
      if (settled.status !== "interrupted") {
        const notification: V1Notification = {
          agentId: id,
          content: `<subagent_notification>\n${JSON.stringify({ agent_path: id, status: publicStatus(settled) })}\n</subagent_notification>`,
          id: attemptId,
        };
        draft.state.notifications.push(notification);
      }
      if (next !== undefined) {
        settled = pendingAgent(settled, next, queue);
        hasNext = true;
      }
      draft.state.agents[index] = settled;
    });
    this.#notifyWaiters(id);
    if (hasNext) {
      this.#scheduleDeliveryFromLastContext(id);
    }
  }

  #scheduleDeliveryFromLastContext(id: string): void {
    const ctx = this.#runtimeOwners.get(id)?.context;
    if (ctx !== undefined) {
      this.#scheduleDelivery(id, ctx);
    }
  }

  async #promoteNext(id: string): Promise<void> {
    await this.#coordinator.transact((draft) => {
      if (draft.protocolLatch !== "v1") {
        return;
      }
      const index = draft.state.agents.findIndex(
        (candidate) => candidate.id === id
      );
      const agent = draft.state.agents[index];
      if (agent === undefined || agent.active !== undefined) {
        return;
      }
      const [next, ...queue] = agent.queue;
      if (next !== undefined) {
        draft.state.agents[index] = pendingAgent(agent, next, queue);
      }
    });
  }

  async #restoreAgent(
    agent: V1PersistedAgent,
    ctx: CallerContext,
    epoch: symbol
  ): Promise<void> {
    try {
      await this.#load(agent.id, ctx, false, epoch);
      if (agent.active?.phase === "pending") {
        this.#scheduleDelivery(agent.id, ctx, epoch);
      } else if (agent.active === undefined && agent.queue.length > 0) {
        this.#assertEpoch(epoch);
        await this.#promoteNext(agent.id);
        this.#scheduleDelivery(agent.id, ctx, epoch);
      }
    } catch (error) {
      if (epoch === this.#epoch) {
        await this.#markError(agent.id, error, undefined, epoch);
      }
    }
  }

  async #observeDelivery(
    id: string,
    started: Promise<
      | {
          attemptId: string;
          childTurn: ReturnType<ChildRuntime["startTurn"]>;
        }
      | undefined
    >,
    epoch: symbol
  ): Promise<void> {
    let active:
      | {
          attemptId: string;
          childTurn: ReturnType<ChildRuntime["startTurn"]>;
        }
      | undefined;
    try {
      active = await started;
    } catch (error) {
      if (epoch !== this.#epoch) {
        return;
      }
      try {
        await this.#markError(id, error, undefined, epoch);
      } catch (publicationError) {
        await this.#retire(id);
        this.#onBackgroundError?.(publicationError);
        return;
      }
      if (error instanceof PermanentChildError) {
        await this.#retire(id);
      }
      return;
    }
    if (active === undefined) {
      return;
    }
    try {
      const final = await active.childTurn.settled;
      await this.#serial(
        id,
        async () => {
          try {
            await this.#finish(id, active.attemptId, final, epoch);
          } catch (error) {
            await this.#retire(id);
            throw error;
          }
        },
        epoch
      );
    } catch (error) {
      try {
        await this.#serial(
          id,
          async () => {
            try {
              await this.#markError(id, error, active.attemptId, epoch);
            } catch (publicationError) {
              await this.#retire(id);
              throw publicationError;
            }
            if (error instanceof PermanentChildError) {
              await this.#retire(id);
            }
          },
          epoch
        );
      } catch (publicationError) {
        this.#onBackgroundError?.(publicationError);
      }
    }
  }

  async #retire(id: string): Promise<void> {
    const owner = this.#runtimeOwners.get(id);
    if (owner === undefined) {
      return;
    }
    const { state } = owner;
    owner.state = { kind: "vacant" };
    if (state.kind === "ready") {
      await state.runtime.dispose();
    }
  }

  #takeRuntimeOperations(): Promise<void>[] {
    const operations = [...this.#runtimeOwners.values()].flatMap(
      ({ state }) => {
        if (state.kind === "ready") {
          return [
            reportFailure(state.runtime.dispose(), this.#onBackgroundError),
          ];
        }
        if (state.kind === "loading") {
          return [reportFailure(state.promise)];
        }
        return [];
      }
    );
    this.#runtimeOwners.clear();
    return operations;
  }

  async #markError(
    id: string,
    error: unknown,
    attemptId: string | undefined,
    epoch: symbol
  ): Promise<void> {
    let hasNext = false;
    await this.#coordinator.transact((draft) => {
      this.#assertEpoch(epoch);
      if (draft.protocolLatch !== "v1") {
        return;
      }
      const index = draft.state.agents.findIndex(
        (candidate) => candidate.id === id
      );
      const agent = draft.state.agents[index];
      if (
        agent === undefined ||
        agent.edge === "closed" ||
        (attemptId !== undefined && agent.active?.id !== attemptId)
      ) {
        return;
      }
      if (agent.status === "errored") {
        return;
      }
      const message = bound(
        error instanceof Error ? error.message : String(error),
        MAX_ERROR_LENGTH
      );
      const notificationId = attemptId ?? agent.active?.id ?? this.#id();
      draft.state.notifications.push({
        agentId: id,
        content: `<subagent_notification>\n${JSON.stringify({ agent_path: id, status: { errored: message } })}\n</subagent_notification>`,
        id: notificationId,
      });
      const [next, ...queue] = agent.queue;
      const failed = erroredAgent(agent, queue, message, true);
      if (next === undefined) {
        draft.state.agents[index] = failed;
      } else {
        draft.state.agents[index] = pendingAgent(failed, next, queue);
        hasNext = true;
      }
    });
    this.#notifyWaiters(id);
    if (hasNext) {
      this.#scheduleDeliveryFromLastContext(id);
    }
  }

  #notifyWaiters(id: string): void {
    for (const wake of this.#waiters.get(id) ?? []) {
      wake();
    }
  }

  #cancelWaiters(): void {
    for (const waiters of this.#waiters.values()) {
      for (const wake of waiters) {
        wake();
      }
    }
    this.#waiters.clear();
  }

  #agent(id: string): V1PersistedAgent | undefined {
    return this.#state().agents.find((agent) => agent.id === id);
  }

  #state(): Readonly<V1Snapshot> {
    const snapshot = this.#coordinator.state;
    if (snapshot.protocolLatch !== "v1") {
      throw new Error("V1 is not active");
    }
    return snapshot.state;
  }

  #assertEpoch(epoch: symbol): void {
    if (epoch !== this.#epoch) {
      throw new Error("Stale V1 controller operation");
    }
  }

  async #serial<T>(
    id: string,
    operation: () => Promise<T>,
    epoch: symbol = this.#epoch
  ): Promise<T> {
    return await this.#queue.run(id, async () => {
      this.#assertEpoch(epoch);
      if (this.#closing) {
        throw new Error("Subagent controller is shutting down");
      }
      return await operation();
    });
  }
}
