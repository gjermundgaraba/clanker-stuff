import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

import type { BuildSystemPromptOptions, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AgentThinkingLevel, SubagentsConfig } from "./config.js";
import { resolveChildSettings } from "./config.js";
import { inheritDelegation, readDelegation } from "./delegation.js";
import type { DelegationPolicy } from "./delegation.js";
import { forkHistory } from "./history.js";
import type { ForkTurns } from "./history.js";
import { KeyedSerialQueue } from "./keyed-queue.js";
import { childPrompt, COLLABORATION_SECTION, errorCompletion } from "./prompts.js";
import {
  childAgentPath,
  emptyTree,
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

const bound = (value: string, maximum: number): string => {
  if (value.length <= maximum) {
    return value;
  }

  const end = /[\uD800-\uDBFF]/u.test(value[maximum - 2] ?? "") ? maximum - 2 : maximum - 1;

  return `${value.slice(0, end)}…`;
};

const errorText = (cause: unknown): string =>
  bound(cause instanceof Error ? cause.message : String(cause), MAX_STATUS_TEXT);

/** Waits for `work` unless `signal` aborts first; aborting abandons the wait, not the work. */
const waitUnlessAborted = async (
  work: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> => {
  if (signal === undefined) {
    return await work;
  }

  const aborted = Promise.withResolvers<never>();
  const abort = () => aborted.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });

  try {
    signal.throwIfAborted();
    await Promise.race([work, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
};

export type CallerContext = Pick<
  ExtensionContext,
  "cwd" | "isProjectTrusted" | "model" | "modelRegistry" | "sessionManager" | "thinkingLevel"
>;

interface Resident {
  runtime: ChildRuntime;
  /** Settles once the turn's outcome has been recorded or ignored. */
  settled: Promise<void>;
  /** Identifies the turn whose outcome may still update this node. */
  turn: symbol | undefined;
  /** Set when retired; the resident keeps its slot and session until disposal settles. */
  retiring?: Promise<void>;
}

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

export interface SpawnResult {
  model: string;
  task_name: string;
  thinkingLevel: AgentThinkingLevel;
}

export interface AgentListing {
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
}

type WaitActivity = "aborted" | "mailbox" | "steered" | "timed_out";

export class Controller {
  readonly #config: SubagentsConfig;
  readonly #createRuntime: ChildRuntimeFactory;
  readonly #dataDir: string;
  readonly #deliverRoot: (mail: Mail) => void;
  readonly #onBackgroundError: (cause: unknown) => void;
  readonly #queue = new KeyedSerialQueue();
  readonly #residents = new Map<string, Resident>();
  readonly #rootRunning: () => boolean;
  readonly #starting = new Set<string>();
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
    this.#rootRunning = dependencies.rootRunning;
  }

  setPromptOptions(options: BuildSystemPromptOptions): void {
    this.#promptOptions = options;
  }

  /** Replaces the tree; agents that were running when it was last saved are now interrupted. */
  async open(store: TreeStore, tree: Tree): Promise<void> {
    await this.shutdown();
    this.#store = store;
    this.#tree = tree;
    const stranded = tree.nodes.filter((node) => node.status === "running");

    for (const node of stranded) {
      node.status = "interrupted";
    }

    if (stranded.length > 0) {
      await this.#save();
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
    const retiring = [...this.#residents].map(([path, resident]) => this.#retire(path, resident));

    this.#residents.clear();
    await Promise.allSettled(retiring);
  }

  rootMail(): readonly Mail[] {
    return this.#tree.outbox.filter((mail) => mail.to === ROOT_AGENT_PATH);
  }

  async acknowledge(ids: readonly string[]): Promise<void> {
    const delivered = new Set(ids);
    const remaining = this.#tree.outbox.filter((mail) => !delivered.has(mail.id));

    if (remaining.length !== this.#tree.outbox.length) {
      this.#tree.outbox = remaining;
      await this.#save();
    }
  }

  async spawn(
    caller: string,
    input: SpawnInput,
    ctx: CallerContext,
    signal?: AbortSignal,
  ): Promise<SpawnResult> {
    const epoch = this.#epoch;
    const path = childAgentPath(caller, input.taskName);

    if (input.message.trim() === "") {
      throw new Error("message must not be blank");
    }

    if (this.#node(path) !== undefined || this.#starting.has(path)) {
      throw new Error(`Agent already exists: ${path}`);
    }

    this.#reserve(path);
    let runtime: ChildRuntime | undefined;

    try {
      const tools = [...input.tools];

      const settings = resolveChildSettings(
        this.#config,
        { agentType: input.agentType, model: input.model, thinking: input.thinking },
        { model: ctx.model, registry: ctx.modelRegistry, thinking: ctx.thinkingLevel },
      );

      runtime = await this.#runtime(path, ctx, epoch, {
        history: forkHistory(ctx.sessionManager.buildSessionProjection().messages, input.forkTurns),
        instructions: settings.instructions,
        model: settings.model,
        sessionFile: undefined,
        thinkingLevel: settings.thinking,
        tools,
        delegation: readDelegation(ctx.sessionManager, this.#config.delegation),
      });
      signal?.throwIfAborted();
      this.#assertEpoch(epoch);

      const node: AgentNode = {
        ...(input.agentType === undefined ? {} : { agentType: input.agentType }),
        model: runtime.model,
        path,
        sessionFile: runtime.sessionFile,
        status: "running",
        thinking: runtime.thinkingLevel,
        tools,
      };

      this.#tree.nodes.push(node);

      try {
        await this.#save();
        this.#assertEpoch(epoch);
      } catch (error) {
        this.#tree.nodes = this.#tree.nodes.filter((candidate) => candidate !== node);
        throw error;
      }

      this.#start(
        path,
        runtime,
        envelopeText({
          content: input.message,
          from: caller,
          kind: "NEW_TASK",
          to: path,
        }),
      );

      return { model: runtime.model, task_name: path, thinkingLevel: runtime.thinkingLevel };
    } catch (error) {
      if (runtime !== undefined) {
        await runtime.dispose();
        await rm(runtime.sessionFile, { force: true });
      }

      throw error;
    } finally {
      this.#starting.delete(path);
    }
  }

  async sendMessage(caller: string, target: string, message: string): Promise<void> {
    if (message.trim() === "") {
      throw new Error("message must not be blank");
    }

    const to = resolveAgentPath(caller, target);

    if (to !== ROOT_AGENT_PATH) {
      this.#requireNode(to);
    }

    await this.#post(
      { content: message, from: caller, id: randomUUID(), kind: "MESSAGE", to },
      this.#epoch,
    );
  }

  async followUp(
    caller: string,
    target: string,
    message: string,
    ctx: CallerContext,
    signal?: AbortSignal,
  ): Promise<void> {
    if (message.trim() === "") {
      throw new Error("message must not be blank");
    }

    const path = resolveAgentPath(caller, target);

    if (path === ROOT_AGENT_PATH) {
      throw new Error("followup_task cannot target the root agent");
    }

    const epoch = this.#epoch;
    const task = { content: message, from: caller, kind: "NEW_TASK" as const, to: path };

    for (;;) {
      const settling = await this.#serial(path, epoch, async () => {
        signal?.throwIfAborted();
        const node = this.#requireNode(path);
        let resident = this.#residents.get(path);

        // Reopening the session before the retired runtime closes it would give the file two writers.
        if (resident?.retiring !== undefined) {
          await waitUnlessAborted(resident.retiring, signal);
          signal?.throwIfAborted();
          this.#assertEpoch(epoch);
          resident = this.#residents.get(path);
        }

        if (resident !== undefined) {
          const read = resident.runtime.steer(task);

          if (read === undefined) {
            // Recording the ended turn's outcome needs this key, so wait for it outside.
            return { turn: resident.settled };
          }

          // A pending wait_agent call would hold the steered task until it times out.
          this.notify(path);

          // A turn can settle without reading the task; it then starts a turn of its own, unless
          // the agent was interrupted or the tree replaced meanwhile.
          read
            .then((delivered) =>
              delivered || epoch !== this.#epoch || this.#node(path)?.status === "interrupted"
                ? undefined
                : this.followUp(caller, target, message, ctx),
            )
            .catch((error: unknown) => {
              if (epoch === this.#epoch) {
                this.#onBackgroundError(error);
              }
            });

          return undefined;
        }

        this.#reserve(path);
        const previous = { ...node };
        let runtime: ChildRuntime | undefined;

        try {
          runtime = await this.#load(node, ctx, epoch);
          signal?.throwIfAborted();
          // Child extensions can switch models at session start, as on spawn.
          node.model = runtime.model;
          node.thinking = runtime.thinkingLevel;
          node.status = "running";
          delete node.error;
          await this.#save();
          this.#assertEpoch(epoch);
          this.#start(path, runtime, envelopeText(task));
        } catch (error) {
          Object.assign(node, previous);
          await runtime?.dispose();
          throw error;
        } finally {
          this.#starting.delete(path);
        }

        return undefined;
      });

      if (settling === undefined) {
        return;
      }

      await waitUnlessAborted(settling.turn, signal);
    }
  }

  async interrupt(caller: string, target: string): Promise<{ previous_status: PublicAgentStatus }> {
    const path = resolveAgentPath(caller, target);

    if (path === ROOT_AGENT_PATH || path === caller) {
      throw new Error("An agent cannot interrupt itself or the root agent");
    }

    const epoch = this.#epoch;

    return await this.#serial(path, epoch, async () => {
      const node = this.#node(path);
      const previous = publicStatus(node);

      if (node?.status === "running") {
        node.status = "interrupted";
        const resident = this.#residents.get(path);

        if (resident !== undefined) {
          resident.turn = undefined;
          resident.runtime.abort();
          void this.#retire(path, resident);
        }

        await this.#save();
      }

      return { previous_status: previous };
    });
  }

  list(caller: string, prefix: string | undefined): AgentListing[] {
    const scope =
      prefix === undefined || prefix === "" ? ROOT_AGENT_PATH : resolveAgentPath(caller, prefix);

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
      .filter(({ agent_name }) => agent_name === scope || agent_name.startsWith(`${scope}/`))
      .toSorted((left, right) => left.agent_name.localeCompare(right.agent_name));
  }

  describe(): string {
    if (this.#tree.nodes.length === 0) {
      return "No subagents in this session.";
    }

    return this.#tree.nodes.map((node) => `${node.path}  ${node.status}  ${node.model}`).join("\n");
  }

  /** Waits until mail reaches `caller`, new user input arrives, or the timeout passes. */
  async wait(
    caller: string,
    timeoutMs: number,
    signal?: AbortSignal,
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

    const wake = (activity: WaitActivity) => {
      settled.resolve(activity);
    };

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

      let message = "Wait interrupted by new input.";

      if (activity === "timed_out") {
        message = "Wait timed out.";
      } else if (activity === "mailbox") {
        message = "Wait completed.";
      }

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

  #reserve(path: string): void {
    if (this.#residents.size + this.#starting.size >= this.#config.maxConcurrent) {
      throw new Error(`Subagent concurrency limit reached (${this.#config.maxConcurrent})`);
    }

    this.#starting.add(path);
  }

  async #load(node: AgentNode, ctx: CallerContext, epoch: symbol): Promise<ChildRuntime> {
    const slash = node.model.indexOf("/");
    const model = ctx.modelRegistry.find(node.model.slice(0, slash), node.model.slice(slash + 1));

    if (model === undefined) {
      throw new Error(`Model ${node.model} for ${node.path} is no longer available`);
    }

    const runtime = await this.#runtime(node.path, ctx, epoch, {
      history: [],
      instructions:
        node.agentType === undefined ? undefined : this.#config.roles[node.agentType]?.instructions,
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

    // Mail that waited while the agent was not resident precedes its new task.
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
    },
  ): Promise<ChildRuntime> {
    return await this.#createRuntime({
      bridge: (api) => {
        inheritDelegation(api, child.delegation);
        registerTools(api, this, path, this.#config);
        api.on("before_agent_start", (event, childCtx) => {
          event.systemPromptOptions.sections[COLLABORATION_SECTION] = childPrompt(
            this.#config,
            path,
            readDelegation(childCtx.sessionManager, this.#config.delegation),
          );
        });
      },
      cwd: ctx.cwd,
      dataDir: this.#dataDir,
      history: child.history,
      model: child.model,
      modelRegistry: ctx.modelRegistry,
      onDelivered: (id) => this.#delivered(id, epoch),
      onError: this.#onBackgroundError,
      prompt: child.instructions ?? "",
      promptOptions: this.#promptOptions,
      sessionFile: child.sessionFile,
      thinkingLevel: child.thinkingLevel,
      tools: child.tools,
      trusted: ctx.isProjectTrusted(),
    });
  }

  #start(path: string, runtime: ChildRuntime, text: string): void {
    const epoch = this.#epoch;
    const turn = Symbol(path);
    const settled = Promise.withResolvers<undefined>();
    this.#residents.set(path, { runtime, settled: settled.promise, turn });

    void (async () => {
      let outcome: ChildTurnOutcome;

      try {
        outcome = await runtime.startTurn(text);
      } catch (error) {
        outcome = { error: errorText(error), status: "errored" };
      }

      try {
        await this.#serial(path, epoch, () => this.#finish(path, turn, outcome, epoch));
      } catch (error) {
        if (epoch === this.#epoch) {
          this.#onBackgroundError(error);
        }
      } finally {
        settled.resolve(undefined);
      }
    })();
  }

  async #finish(
    path: string,
    turn: symbol,
    outcome: ChildTurnOutcome,
    epoch: symbol,
  ): Promise<void> {
    const resident = this.#residents.get(path);
    const node = this.#node(path);

    if (resident?.turn !== turn || node === undefined) {
      return;
    }

    void this.#retire(path, resident);
    const parent = parentAgentPath(path) ?? ROOT_AGENT_PATH;
    let mail: Mail | undefined;

    if (outcome.status === "completed") {
      const answer = outcome.text === undefined ? undefined : bound(outcome.text, MAX_DURABLE_TEXT);
      node.status = "completed";
      delete node.error;

      if (answer === undefined) {
        delete node.lastAnswer;
      } else {
        node.lastAnswer = bound(answer, MAX_STATUS_TEXT);
      }

      mail = {
        content: answer ?? "",
        from: path,
        id: randomUUID(),
        kind: "FINAL_ANSWER",
        to: parent,
      };
    } else if (outcome.status === "errored") {
      node.status = "errored";
      node.error = errorText(outcome.error);
      delete node.lastAnswer;
      mail = {
        content: errorCompletion(node.error),
        from: path,
        id: randomUUID(),
        kind: "FINAL_ANSWER",
        to: parent,
      };
    }

    if (mail === undefined) {
      await this.#save();
    } else {
      await this.#post(mail, epoch);
    }
  }

  /** Disposes a resident after its turn; mail for it waits in the outbox until it runs again. */
  #retire(path: string, resident: Resident): Promise<void> {
    if (resident.retiring !== undefined) return resident.retiring;
    const node = this.#node(path);
    const store = this.#store;
    const tree = this.#tree;

    resident.retiring = resident.runtime
      .dispose()
      .finally(async () => {
        if (node !== undefined) {
          // Child extensions can change selection after startup; cold reuse needs its final values.
          node.model = resident.runtime.model;
          node.thinking = resident.runtime.thinkingLevel;
          await store.save(tree);
        }
      })
      .catch(this.#onBackgroundError)
      .finally(() => {
        if (this.#residents.get(path) === resident) {
          this.#residents.delete(path);
        }
      });

    return resident.retiring;
  }

  /** Persists mail before handing it to a resident target; delivery acknowledges it. */
  async #post(mail: Mail, epoch: symbol): Promise<void> {
    this.#tree.outbox.push(mail);
    await this.#save();

    // A replaced tree keeps its mail; delivering it would reach the new session.
    if (epoch !== this.#epoch) {
      return;
    }

    if (mail.to === ROOT_AGENT_PATH) {
      this.#deliverRoot(mail);
    } else {
      const resident = this.#residents.get(mail.to);

      // A retiring child never reads it; its next run receives the mail from the outbox.
      if (resident?.retiring === undefined) {
        resident?.runtime.deliver(mail);
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
  }

  #assertEpoch(epoch: symbol): void {
    if (epoch !== this.#epoch) {
      throw new Error("The subagent tree was closed");
    }
  }

  async #serial<T>(key: string, epoch: symbol, operation: () => Promise<T>): Promise<T> {
    return await this.#queue.run(key, async () => {
      this.#assertEpoch(epoch);

      return await operation();
    });
  }
}
