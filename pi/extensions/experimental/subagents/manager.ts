import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

import type { SubagentsConfig } from "./config.js";
import { Controller } from "./controller.js";
import { COLLABORATION_SECTION, rootPrompt } from "./prompts.js";
import {
  mailMessage,
  MailDetailsSchema,
  ROOT_AGENT_PATH,
  SUBAGENT_MESSAGE_TYPE,
} from "./protocol.js";
import type { Mail } from "./protocol.js";
import { openTree } from "./store.js";
import { registerTools } from "./tools.js";

export interface SubagentManagerOptions {
  config: SubagentsConfig;
  configError: string | undefined;
  dataDir: string;
}

type RootContext = Pick<ExtensionContext, "isIdle" | "sessionManager" | "ui">;

/**
 * Connects the root session to the tree. Root mail is handed to Pi as passive custom messages
 * and leaves the outbox once it appears in the root transcript.
 */
export class SubagentManager {
  readonly #config: SubagentsConfig;
  readonly #configError: string | undefined;
  readonly #controller: Controller;
  readonly #dataDir: string;
  readonly #pi: ExtensionAPI;
  /** Root mail handed to the current session; Pi holds it until the running turn ends. */
  readonly #sent = new Set<string>();
  #ctx: RootContext | undefined;

  constructor(pi: ExtensionAPI, options: SubagentManagerOptions) {
    this.#config = options.config;
    this.#configError = options.configError;
    this.#dataDir = options.dataDir;
    this.#pi = pi;
    this.#controller = new Controller({
      config: options.config,
      dataDir: options.dataDir,
      deliverRoot: (mail) => {
        this.#deliverRoot(mail);
      },
      onBackgroundError: (cause) => {
        this.#report(cause);
      },
      rootRunning: () => this.#ctx?.isIdle() === false,
    });
    registerTools(pi, this.#controller, ROOT_AGENT_PATH, options.config);
  }

  async start(_event: unknown, ctx: ExtensionContext): Promise<void> {
    this.#ctx = ctx;
    this.#sent.clear();

    if (this.#configError !== undefined) {
      ctx.ui.notify(this.#configError, "warning");
    }

    const opened = await openTree(
      this.#dataDir,
      ctx.sessionManager.getSessionId(),
      ctx.sessionManager.getSessionFile() !== undefined,
    );

    if (opened.warning !== undefined) {
      ctx.ui.notify(opened.warning, "warning");
    }

    await this.#controller.open(opened.store, opened.tree);
    await this.#reconcile();

    for (const mail of this.#controller.rootMail()) {
      this.#deliverRoot(mail);
    }
  }

  beforeAgentStart(event: BeforeAgentStartEvent): void {
    this.#controller.setPromptOptions(event.systemPromptOptions);
    event.systemPromptOptions.sections[COLLABORATION_SECTION] = rootPrompt(this.#config);
  }

  input(): void {
    this.#controller.notify(ROOT_AGENT_PATH);
  }

  /** Pi appends passive messages at turn boundaries; acknowledge whatever has landed. */
  async settle(): Promise<void> {
    await this.#reconcile();
  }

  describe(): string {
    return this.#controller.describe();
  }

  async shutdown(): Promise<void> {
    this.#ctx = undefined;
    await this.#controller.shutdown();
  }

  #deliverRoot(mail: Mail): void {
    if (this.#ctx === undefined || this.#sent.has(mail.id)) {
      return;
    }

    this.#sent.add(mail.id);
    // An idle session appends at once; a running one appends when the current turn ends.
    this.#pi.sendMessage(mailMessage(mail), { triggerTurn: false });
    this.#reconcile().catch((cause: unknown) => {
      this.#report(cause);
    });
  }

  async #reconcile(): Promise<void> {
    const pending = this.#controller.rootMail();

    if (pending.length === 0 || this.#ctx === undefined) {
      return;
    }

    const transcribed = new Set(
      this.#ctx.sessionManager
        .getEntries()
        .flatMap((entry) =>
          entry.type === "custom_message" &&
          entry.customType === SUBAGENT_MESSAGE_TYPE &&
          Value.Check(MailDetailsSchema, entry.details)
            ? [entry.details.id]
            : [],
        ),
    );

    await this.#controller.acknowledge(
      pending.filter((mail) => transcribed.has(mail.id)).map((mail) => mail.id),
    );
  }

  #report(cause: unknown): void {
    this.#ctx?.ui.notify(
      `Subagent background failure: ${cause instanceof Error ? cause.message : String(cause)}`,
      "error",
    );
  }
}
