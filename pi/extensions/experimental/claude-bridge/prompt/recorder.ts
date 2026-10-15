// Records what pi assembled at each boundary where the provider's prompt can change.

import type {
  BeforeAgentStartEvent,
  BuildSystemPromptOptions,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { PromptCaptures } from "./capture.js";

export class PromptRecorder {
  // The options are pi config, stable across a run; only the generated tool list in the
  // rendered prompt varies. Stashed at before_agent_start for the later boundaries.
  private lastOptions: BuildSystemPromptOptions | undefined;

  constructor(private readonly captures: PromptCaptures) {}

  // `--system-prompt` replaces pi's default, but Claude Code's preset carries tool and
  // permission guidance the bridge still depends on, so both flags are forwarded as an
  // append rather than a replacement.
  beforeAgentStart(event: BeforeAgentStartEvent): void {
    this.lastOptions = event.systemPromptOptions;
    this.record("before_agent_start", event.systemPrompt);
  }

  // The prompt the provider queries with is the fully widened one: MCP tool descriptions
  // merge in only after their servers connect, after before_agent_start. A subagent
  // embeds that widened parent prompt verbatim, so unless it is a capture key too the
  // child's turn resolves against nothing. agent_start also sees a handler-returned
  // forceSystemPrompt, which pi renders verbatim.
  agentStart(ctx: ExtensionContext): void {
    this.record("agent_start", ctx.getSystemPrompt());
  }

  // turn_start fires before every turn once its prompt is final, including after a
  // mid-run tool-loadout change. The stashed options can lag such a change, which skews
  // the read-tool skills filter until the next run: a stale skills list beats failing
  // the turn.
  turnStart(ctx: ExtensionContext): void {
    this.record("turn_start", ctx.getSystemPrompt());
  }

  private record(source: string, systemPrompt: string): void {
    if (systemPrompt === "") return;

    const options = this.lastOptions;
    const hasRead = options?.selectedTools?.includes("read") ?? true;

    this.captures.record(
      systemPrompt,
      {
        custom: options?.customPrompt,
        append: options?.appendSystemPrompt,
        contextFiles: options?.contextFiles ?? [],
        skills: hasRead ? (options?.skills ?? []) : [],
        sections: options?.sections,
      },
      source,
    );
  }
}
