import { randomUUID } from "node:crypto";

import { errorMessage } from "@clanker-stuff/pi-tool-rendering/text";
import type {
  AgentSessionEvent,
  BuildSystemPromptOptions,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { AgentThinkingLevel, SubagentsConfig } from "./config.js";
import { resolveChildSettings } from "./config.js";
import { inheritDelegation, readDelegation } from "./delegation.js";
import type { DelegationPolicy } from "./delegation.js";
import { forkHistory } from "./history.js";
import type { ForkTurns } from "./history.js";
import { KeyedSerialQueue } from "./keyed-queue.js";
import { Monitor } from "./monitor.js";
import { agentMachine, holdsSlot, project, restore } from "./phase.js";
import type { AgentEvent, AgentSnapshot, Turn } from "./phase.js";
import {
  childPrompt,
  COLLABORATION_SECTION,
  errorCompletion,
} from "./prompts.js";
import {
  bound,
  childAgentPath,
  emptyTree,
  emptyUsage,
  envelopeText,
  parentAgentPath,
  MAX_DURABLE_TEXT,
  MAX_STATUS_TEXT,
  publicStatus,
  resolveAgentPath,
  ROOT_AGENT_PATH,
} from "./protocol.js";
import type { AgentNode, Mail, PublicAgentStatus, Tree } from "./protocol.js";
import { createChildRuntime } from "./runtime.js";
import type {
  ChildRuntime,
  ChildRuntimeFactory,
  ChildRuntimeRequest,
  ChildTurnOutcome,
} from "./runtime.js";
import { TreeStore } from "./store.js";
import { registerTools } from "./tools.js";

const errorText = (cause: unknown): string =>
  bound(errorMessage(cause), MAX_STATUS_TEXT);

const waitUnlessAborted = async (
  work: Promise<void>,
  signal: AbortSignal | undefined
): Promise<void> => {
  if (signal === undefined) {
    await work;

    return;
  }

  const aborted = Promise.withResolvers<never>();

  const abort = () => {
    aborted.reject(signal.reason);
  };

  signal.addEventListener("abort", abort, { once: true });

  try {
    signal.throwIfAborted();
    await Promise.race([work, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
};

const record = (node: AgentNode, agent: AgentSnapshot): void => {
  const recorded = project(agent);

  if (recorded !== null) {
    delete node.endedAt;
    delete node.error;
    delete node.lastAnswer;
    Object.assign(node, recorded);
  }
};

type CallerContext = Pick<
  ExtensionContext,
  | "cwd"
  | "isProjectTrusted"
  | "model"
  | "modelRegistry"
  | "sessionManager"
  | "thinkingLevel"
>;

export interface SpawnInput {
  agentType: string | undefined;
  forkTurns: ForkTurns;
  message: string;
  model: string | undefined;
  taskName: string;
  thinking: AgentThinkingLevel | undefined;
  /** The caller's active tools, which the child starts with. */
  tools: readonly string[];
}

interface SpawnResult {
  model: string;
  task_name: string;
  thinkingLevel: AgentThinkingLevel;
}

interface AgentListing {
  agent_name: string;
  agent_status: PublicAgentStatus;
}

export interface ControllerDependencies {
  config: SubagentsConfig;
  createRuntime?: ChildRuntimeFactory;
  dataDir: string;
  /** Hands root mail to the root session; the manager acknowledges it once transcribed. */
  deliverRoot: (mail: Mail) => void;
  onBackgroundError: (cause: unknown) => void;
  rootRunning: () => boolean;
  /** Clock for the timestamps the tree records. */
  now?: () => number;
}

type WaitActivity = "aborted" | "mailbox" | "steered" | "timed_out";

const WAIT_MESSAGES: Record<Exclude<WaitActivity, "aborted">, string> = {
  mailbox: "Wait completed.",
  steered: "Wait interrupted by new input.",
  timed_out: "Wait timed out.",
};

export class Controller {
  /** Presentation feed; the controller only publishes to it. */
  readonly monitor: Monitor;
  readonly #config: SubagentsConfig;
  readonly #createRuntime: ChildRuntimeFactory;
  readonly #dataDir: string;
  readonly #now: () => number;
  readonly #deliverRoot: (mail: Mail) => void;
  readonly #onBackgroundError: (cause: unknown) => void;
  readonly #agents = new Map<string, AgentSnapshot>();
  readonly #queue = new KeyedSerialQueue();
  readonly #rootRunning: () => boolean;
  readonly #unread = new Set<string>();
  readonly #waiters = new Map<string, Set<(activity: WaitActivity) => void>>();
  #epoch = Symbol("tree");
  #promptOptions: BuildSystemPromptOptions | undefined;
  #store = new TreeStore(undefined);
  #tree: Tree = emptyTree();

  constructor(dependencies: ControllerDependencies) {
    this.#config = dependencies.config;
    this.#createRuntime = dependencies.createRuntime ?? createChildRuntime;
    this.#dataDir = dependencies.dataDir;
    this.#deliverRoot = dependencies.deliverRoot;
    this.#onBackgroundError = dependencies.onBackgroundError;
    this.monitor = new Monitor(dependencies.onBackgroundError);
    this.#rootRunning = dependencies.rootRunning;
    this.#now = dependencies.now ?? Date.now;
  }

  setPromptOptions(options: BuildSystemPromptOptions): void {
    this.#promptOptions = options;
  }

  /** Replaces the tree; agents that were running when it was last saved are now interrupted. */
  async open(store: TreeStore, tree: Tree): Promise<void> {
    await this.shutdown();
    this.#store = store;
    this.#tree = tree;
    let stranded = false;

    for (const node of tree.nodes) {
      stranded ||= node.status === "running";
      const agent = restore(node);
      this.#agents.set(node.path, agent);
      record(node, agent);
    }

    if (stranded) {
      await this.#save();
    } else {
      this.monitor.changed();
    }
  }

  async shutdown(): Promise<void> {
    this.#epoch = Symbol("tree");
    this.#queue.clear();
    this.#unread.clear();

    for (const waiters of this.#waiters.values()) {
      for (const wake of waiters) {
        wake("steered");
      }
    }

    this.#waiters.clear();

    const retiring = [...this.#agents].map(async ([path, agent]) => {
      if (agent.value === "running") {
        await this.#retire(path, agent.context.turn);
      } else if (agent.value === "retiring") {
        await agent.context.turn.retired.promise;
      }
    });

    this.#agents.clear();
    await Promise.allSettled(retiring);
  }

  rootMail(): readonly Mail[] {
    return this.#tree.outbox.filter((mail) => mail.to === ROOT_AGENT_PATH);
  }

  async acknowledge(ids: readonly string[]): Promise<void> {
    const delivered = new Set(ids);

    const remaining = this.#tree.outbox.filter(
      (mail) => !delivered.has(mail.id)
    );

    if (remaining.length !== this.#tree.outbox.length) {
      this.#tree.outbox = remaining;
      await this.#save();
    }
  }

  async spawn(
    caller: string,
    input: SpawnInput,
    ctx: CallerContext,
    signal?: AbortSignal
  ): Promise<SpawnResult> {
    const epoch = this.#epoch;
    const path = childAgentPath(caller, input.taskName);

    if (input.message.trim() === "") {
      throw new Error("message must not be blank");
    }

    if (this.#phase(path).value !== "absent") {
      throw new Error(`Agent already exists: ${path}`);
    }

    this.#reserve(path, { type: "spawn.reserve" });
    let runtime: ChildRuntime | undefined;
    let published = false;
    let publishedNode: AgentNode | undefined;

    try {
      const tools = [...input.tools];

      const settings = resolveChildSettings(
        this.#config,
        {
          agentType: input.agentType,
          model: input.model,
          thinking: input.thinking,
        },
        {
          model: ctx.model,
          registry: ctx.modelRegistry,
          thinking: ctx.thinkingLevel,
        }
      );

      runtime = await this.#runtime(path, ctx, epoch, {
        history: forkHistory(
          ctx.sessionManager.buildSessionProjection().messages,
          input.forkTurns
        ),
        instructions: settings.instructions,
        model: settings.model,
        sessionFile: undefined,
        thinkingLevel: settings.thinking,
        tools,
        delegation: readDelegation(ctx.sessionManager, this.#config.delegation),
      });
      signal?.throwIfAborted();
      const turn: Turn = { retired: Promise.withResolvers(), runtime };

      await this.#serial(path, epoch, async () => {
        const tree = this.#tree;

        const node: AgentNode = {
          ...(input.agentType === undefined
            ? {}
            : { agentType: input.agentType }),
          model: turn.runtime.model,
          path,
          sessionFile: turn.runtime.sessionFile,
          startedAt: this.#now(),
          status: "running",
          thinking: turn.runtime.thinkingLevel,
          tools,
          usage: emptyUsage(),
        };

        tree.nodes.push(node);

        try {
          await this.#saveAndStart(
            node,
            { turn, type: "spawn.started" },
            envelopeText({
              content: input.message,
              from: caller,
              kind: "NEW_TASK",
              to: path,
            }),
            epoch,
            () => {
              published = true;
              publishedNode = node;
            }
          );
        } catch (error) {
          if (!published) {
            tree.nodes = tree.nodes.filter((candidate) => candidate !== node);
          }

          throw error;
        }
      });

      return {
        model: runtime.model,
        task_name: path,
        thinkingLevel: runtime.thinkingLevel,
      };
    } catch (error) {
      if (epoch === this.#epoch) {
        this.#step(path, { type: "spawn.failed" });

        if (publishedNode !== undefined) {
          publishedNode.status = "interrupted";
          this.#agents.set(path, restore(publishedNode));
        }
      }

      const failures: unknown[] = [error];

      if (runtime !== undefined) {
        try {
          await (published ? runtime.dispose() : runtime.discard());
        } catch (cleanupError) {
          failures.push(cleanupError);
        }

        if (epoch === this.#epoch && publishedNode !== undefined) {
          try {
            await this.#save();
          } catch (saveError) {
            failures.push(saveError);
          }
        }
      }

      if (failures.length > 1) {
        throw new AggregateError(failures, "Child spawn and recovery failed", {
          cause: error,
        });
      }

      throw error;
    }
  }

  async sendMessage(
    caller: string,
    target: string,
    message: string
  ): Promise<void> {
    if (message.trim() === "") {
      throw new Error("message must not be blank");
    }

    const to = resolveAgentPath(caller, target);

    if (to !== ROOT_AGENT_PATH) {
      this.#requireNode(to);
    }

    await this.#post(
      { content: message, from: caller, id: randomUUID(), kind: "MESSAGE", to },
      this.#epoch
    );
  }

  async followUp(
    caller: string,
    target: string,
    message: string,
    ctx: CallerContext,
    signal?: AbortSignal
  ): Promise<void> {
    if (message.trim() === "") {
      throw new Error("message must not be blank");
    }

    const path = resolveAgentPath(caller, target);

    if (path === ROOT_AGENT_PATH) {
      throw new Error("followup_task cannot target the root agent");
    }

    const epoch = this.#epoch;

    const task = {
      content: message,
      from: caller,
      kind: "NEW_TASK" as const,
      to: path,
    };

    for (;;) {
      const busy = await this.#serial(
        path,
        epoch,
        async (): Promise<{ retired: Promise<undefined> } | undefined> => {
          signal?.throwIfAborted();
          const node = this.#requireNode(path);
          const agent = this.#phase(path);

          if (agent.value === "retiring") {
            return { retired: agent.context.turn.retired.promise };
          }

          if (agent.value === "running") {
            const read = agent.context.turn.runtime.steer(task);

            if (read === undefined) {
              return { retired: agent.context.turn.retired.promise };
            }

            this.notify(path);

            void (async () => {
              try {
                const delivered = await read;

                if (
                  delivered ||
                  epoch !== this.#epoch ||
                  this.#node(path)?.status === "interrupted"
                ) {
                  return;
                }

                await this.followUp(caller, target, message, ctx);
              } catch (error) {
                if (epoch === this.#epoch) {
                  this.#onBackgroundError(error);
                }
              }
            })();

            return;
          }

          this.#reserve(path, { type: "followup.reserve" });
          const { model, startedAt, thinking } = node;
          let runtime: ChildRuntime | undefined;

          try {
            runtime = await this.#load(node, ctx, epoch);
            signal?.throwIfAborted();
            node.model = runtime.model;
            node.thinking = runtime.thinkingLevel;
            node.startedAt = this.#now();
            await this.#saveAndStart(
              node,
              {
                turn: { retired: Promise.withResolvers(), runtime },
                type: "followup.started",
              },
              envelopeText(task),
              epoch
            );
          } catch (error) {
            Object.assign(node, { model, startedAt, thinking });

            if (epoch === this.#epoch) {
              this.#step(path, { type: "followup.failed" });
            }

            await runtime?.dispose();
            throw error;
          }

          return undefined;
        }
      );

      if (busy === undefined) {
        return;
      }

      await waitUnlessAborted(busy.retired, signal);
    }
  }

  async interrupt(
    caller: string,
    target: string
  ): Promise<{ previous_status: PublicAgentStatus }> {
    const path = resolveAgentPath(caller, target);

    if (path === ROOT_AGENT_PATH || path === caller) {
      throw new Error("An agent cannot interrupt itself or the root agent");
    }

    const epoch = this.#epoch;

    return await this.#serial(path, epoch, async () => {
      const previous = publicStatus(this.#node(path));
      const agent = this.#phase(path);
      this.#step(path, { at: this.#now(), type: "interrupt" });

      if (agent.value === "running") {
        agent.context.turn.runtime.abort();
        void this.#retire(path, agent.context.turn);
        await this.#save();
      }

      return { previous_status: previous };
    });
  }

  list(caller: string, prefix: string | undefined): AgentListing[] {
    const scope =
      prefix === undefined || prefix === ""
        ? ROOT_AGENT_PATH
        : resolveAgentPath(caller, prefix);

    const root: AgentListing = {
      agent_name: ROOT_AGENT_PATH,
      agent_status: this.#rootRunning() ? "running" : { completed: null },
    };

    return [
      root,
      ...this.#tree.nodes.map((node) => ({
        agent_name: node.path,
        agent_status: publicStatus(node),
      })),
    ]
      .filter(
        ({ agent_name }) =>
          agent_name === scope || agent_name.startsWith(`${scope}/`)
      )
      .toSorted((left, right) =>
        left.agent_name.localeCompare(right.agent_name)
      );
  }

  /** The tree's agents, for presentation; callers must not mutate them. */
  nodes(): readonly AgentNode[] {
    return this.#tree.nodes;
  }

  rootRunning(): boolean {
    return this.#rootRunning();
  }

  /** The runtime of an agent whose turn is still live, for viewers that follow it. */
  live(path: string): ChildRuntime | undefined {
    const agent = this.#phase(path);

    return agent.value === "running" ? agent.context.turn.runtime : undefined;
  }

  /** Waits until mail reaches `caller`, new user input arrives, or the timeout passes. */
  async wait(
    caller: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<{ message: string; timed_out: boolean }> {
    if (!Number.isInteger(timeoutMs)) {
      throw new TypeError("timeout_ms must be an integer");
    }

    if (timeoutMs > 3_600_000) {
      throw new Error("timeout_ms must not exceed 3600000");
    }

    signal?.throwIfAborted();
    const effective = Math.max(10_000, timeoutMs);
    const settled = Promise.withResolvers<WaitActivity>();

    const wake = settled.resolve;

    const abort = () => {
      settled.resolve("aborted");
    };

    if (this.#unread.delete(caller)) {
      settled.resolve("mailbox");
    }

    const waiters = this.#waiters.get(caller) ?? new Set();
    waiters.add(wake);
    this.#waiters.set(caller, waiters);
    signal?.addEventListener("abort", abort, { once: true });

    const timer = setTimeout(() => {
      settled.resolve("timed_out");
    }, effective);

    try {
      const activity = await settled.promise;

      if (activity === "aborted") {
        signal?.throwIfAborted();
        throw new Error("Wait aborted");
      }

      let message = WAIT_MESSAGES[activity];

      if (timeoutMs < effective) {
        message += `\n\nRequested timeout of ${timeoutMs}ms was clamped to the minimum of ${effective}ms.`;
      }

      return { message, timed_out: activity === "timed_out" };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      waiters.delete(wake);
    }
  }

  /** New input reached `path`; a pending wait returns so the agent can respond. */
  notify(path: string): void {
    for (const wake of this.#waiters.get(path) ?? []) {
      wake("steered");
    }
  }

  #reserve(
    path: string,
    event: Extract<AgentEvent, { type: "followup.reserve" | "spawn.reserve" }>
  ): void {
    if (
      this.#agents.values().filter(holdsSlot).toArray().length >=
      this.#config.maxConcurrent
    ) {
      throw new Error(
        `Subagent concurrency limit reached (${this.#config.maxConcurrent})`
      );
    }

    this.#step(path, event);
  }

  async #load(
    node: AgentNode,
    ctx: CallerContext,
    epoch: symbol
  ): Promise<ChildRuntime> {
    const slash = node.model.indexOf("/");

    const model = ctx.modelRegistry.find(
      node.model.slice(0, slash),
      node.model.slice(slash + 1)
    );

    if (model === undefined) {
      throw new Error(
        `Model ${node.model} for ${node.path} is no longer available`
      );
    }

    const runtime = await this.#runtime(node.path, ctx, epoch, {
      history: [],
      instructions:
        node.agentType === undefined
          ? undefined
          : this.#config.roles[node.agentType]?.instructions,
      model,
      sessionFile: node.sessionFile,
      thinkingLevel: node.thinking,
      tools: node.tools,
      delegation: undefined,
    });

    if (epoch !== this.#epoch) {
      await runtime.dispose();
      this.#assertEpoch(epoch);
    }

    for (const mail of this.#tree.outbox) {
      if (mail.to === node.path) {
        runtime.deliver(mail);
      }
    }

    return runtime;
  }

  /** Creates a child runtime; the caller supplies what differs between a spawn and a reload. */
  async #runtime(
    path: string,
    ctx: CallerContext,
    epoch: symbol,
    child: Pick<
      ChildRuntimeRequest,
      "history" | "model" | "sessionFile" | "thinkingLevel" | "tools"
    > & {
      instructions: string | undefined;
      delegation: DelegationPolicy | undefined;
    }
  ): Promise<ChildRuntime> {
    process.env["PI_CODEMODE_MAX_WORKERS"] ??= String(
      this.#config.maxConcurrent + 2
    );

    return await this.#createRuntime({
      bridge: (api) => {
        inheritDelegation(api, child.delegation);
        registerTools(api, this, path, this.#config);
        api.on("before_agent_start", (event, childCtx) => {
          event.systemPromptOptions.sections[COLLABORATION_SECTION] =
            childPrompt(
              this.#config,
              path,
              readDelegation(childCtx.sessionManager, this.#config.delegation)
            );
        });
      },
      cwd: ctx.cwd,
      dataDir: this.#dataDir,
      history: child.history,
      model: child.model,
      modelRegistry: ctx.modelRegistry,
      onDelivered: (id) => {
        this.#delivered(id, epoch);
      },
      onError: this.#onBackgroundError,
      onEvent: (event) => {
        this.#observe(path, event, epoch);
      },
      prompt: child.instructions ?? "",
      promptOptions: this.#promptOptions,
      sessionFile: child.sessionFile,
      thinkingLevel: child.thinkingLevel,
      tools: child.tools,
      trusted: ctx.isProjectTrusted(),
    });
  }

  async #saveAndStart(
    node: AgentNode,
    event: Extract<AgentEvent, { type: "followup.started" | "spawn.started" }>,
    text: string,
    epoch: symbol,
    onPublishing?: () => void
  ): Promise<void> {
    const { path } = node;
    const [running] = agentMachine.transition(this.#phase(path), event);
    record(node, running);
    onPublishing?.();
    await this.#save();
    this.#assertEpoch(epoch);
    this.#agents.set(path, running);
    const { turn } = event;

    void (async () => {
      let outcome: ChildTurnOutcome;

      try {
        outcome = await turn.runtime.startTurn(text);
      } catch (error) {
        outcome = { error: errorText(error), status: "errored" };
      }

      try {
        await this.#serial(path, epoch, async () => {
          await this.#finish(path, turn, outcome, epoch);
        });
      } catch (error) {
        if (epoch === this.#epoch) {
          this.#onBackgroundError(error);
        }
      }
    })();
  }

  async #finish(
    path: string,
    turn: Turn,
    outcome: ChildTurnOutcome,
    epoch: symbol
  ): Promise<void> {
    const agent = this.#phase(path);

    const next = this.#step(path, {
      at: this.#now(),
      outcome,
      turn,
      type: "turn.settled",
    });

    if (next === agent) {
      return;
    }

    void this.#retire(path, turn);
    const parent = parentAgentPath(path) ?? ROOT_AGENT_PATH;
    let mail: Mail | undefined;

    if (outcome.status === "completed") {
      mail = {
        content:
          outcome.text === undefined
            ? ""
            : bound(outcome.text, MAX_DURABLE_TEXT),
        from: path,
        id: randomUUID(),
        kind: "FINAL_ANSWER",
        to: parent,
      };
    } else if (outcome.status === "errored") {
      mail = {
        content: errorCompletion(errorText(outcome.error)),
        failed: true,
        from: path,
        id: randomUUID(),
        kind: "FINAL_ANSWER",
        to: parent,
      };
    }

    await (mail === undefined ? this.#save() : this.#post(mail, epoch));
  }

  async #retire(path: string, turn: Turn): Promise<void> {
    this.monitor.clear(path);
    const node = this.#node(path);
    const store = this.#store;
    const tree = this.#tree;

    try {
      try {
        await turn.runtime.dispose();
      } finally {
        if (node !== undefined) {
          node.model = turn.runtime.model;
          node.thinking = turn.runtime.thinkingLevel;
          await store.save(tree);
          this.monitor.changed();
        }
      }
    } catch (error) {
      this.#onBackgroundError(error);
    }

    this.#step(path, { turn, type: "retire.done" });
    turn.retired.resolve(undefined);
  }

  /** Persists mail before handing it to a resident target; delivery acknowledges it. */
  async #post(mail: Mail, epoch: symbol): Promise<void> {
    this.#tree.outbox.push(mail);
    await this.#save();

    if (epoch !== this.#epoch) {
      return;
    }

    if (mail.to === ROOT_AGENT_PATH) {
      this.#deliverRoot(mail);
    } else {
      const agent = this.#phase(mail.to);

      if (agent.value === "running") {
        agent.context.turn.runtime.deliver(mail);
      }
    }

    const waiters = this.#waiters.get(mail.to);

    if (waiters === undefined || waiters.size === 0) {
      this.#unread.add(mail.to);
    } else {
      for (const wake of waiters) {
        wake("mailbox");
      }
    }
  }

  #delivered(id: string, epoch: symbol): void {
    if (epoch === this.#epoch) {
      this.acknowledge([id]).catch(this.#onBackgroundError);
    }
  }

  #phase(path: string): AgentSnapshot {
    return this.#agents.get(path) ?? agentMachine.initialState;
  }

  #step(path: string, event: AgentEvent): AgentSnapshot {
    const current = this.#phase(path);
    const [next] = agentMachine.transition(current, event);

    if (next === current) {
      return next;
    }

    if (next.value === "absent") {
      this.#agents.delete(path);
    } else {
      this.#agents.set(path, next);
    }

    const node = this.#node(path);

    if (node !== undefined) {
      record(node, next);
    }

    return next;
  }

  #node(path: string): AgentNode | undefined {
    return this.#tree.nodes.find((node) => node.path === path);
  }

  #requireNode(path: string): AgentNode {
    const node = this.#node(path);

    if (node === undefined) {
      throw new Error(`Unknown agent: ${path}`);
    }

    return node;
  }

  async #save(): Promise<void> {
    await this.#store.save(this.#tree);
    this.monitor.changed();
  }

  /** Counts usage and publishes activity for the current tree's children only. */
  #observe(path: string, event: AgentSessionEvent, epoch: symbol): void {
    if (epoch !== this.#epoch) {
      return;
    }

    if (event.type === "message_end" && event.message.role === "assistant") {
      const usage = this.#node(path)?.usage;

      const { cacheRead, cacheWrite, cost, input, output } =
        event.message.usage;

      if (usage !== undefined) {
        usage.input += input;
        usage.output += output;
        usage.cacheRead += cacheRead;
        usage.cacheWrite += cacheWrite;
        usage.cost += cost.total;
      }
    }

    this.monitor.record(path, event);
  }

  #assertEpoch(epoch: symbol): void {
    if (epoch !== this.#epoch) {
      throw new Error("The subagent tree was closed");
    }
  }

  async #serial<T>(
    key: string,
    epoch: symbol,
    operation: () => Promise<T>
  ): Promise<T> {
    return await this.#queue.run(key, async () => {
      this.#assertEpoch(epoch);

      return await operation();
    });
  }
}
