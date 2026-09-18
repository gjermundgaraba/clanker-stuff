import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const CAPTURED = Symbol("codex execution settings");

export interface ExecutionSettings {
  readonly model: ExtensionContext["model"];
  readonly thinkingLevel: ExtensionContext["thinkingLevel"];
}

type CapturedContext = ExtensionContext & { [CAPTURED]?: ExecutionSettings };

export const captureExecutionSettings = (ctx: CapturedContext): ExecutionSettings => {
  if (ctx[CAPTURED]) return ctx[CAPTURED];
  const selected = ctx.model;
  const model = selected
    ? (ctx.modelRegistry.find(selected.provider, selected.id) ?? selected)
    : undefined;
  return {
    model: model === undefined ? undefined : structuredClone(model),
    thinkingLevel: ctx.thinkingLevel,
  };
};

/** Preserve live UI/session/cancellation getters, freezing only execution settings. */
export const withExecutionSettings = (
  ctx: CapturedContext,
  settings = captureExecutionSettings(ctx),
): ExtensionContext =>
  ctx[CAPTURED] === settings
    ? ctx
    : Object.defineProperties(Object.create(ctx), {
        model: { value: settings.model },
        thinkingLevel: { value: settings.thinkingLevel },
        [CAPTURED]: { value: settings },
      });

/** One extension instance's current session; no request bodies or credentials retained. */
export class ToolExecutionSettings {
  private sessionId: string | undefined;
  private calls = new Map<string, ExecutionSettings>();

  reset(sessionId?: string): void {
    this.sessionId = sessionId;
    this.clear();
  }

  clear(): void {
    this.calls = new Map();
  }

  /** A late response cannot publish into a replaced turn/session generation. */
  beginResponse(sessionId: string): (ids: string[], settings: ExecutionSettings) => void {
    const calls = this.calls;
    const eligible = this.sessionId === sessionId;
    return (ids, settings) => {
      if (!eligible || this.calls !== calls || this.sessionId !== sessionId) return;
      for (const id of ids) calls.set(id, settings);
    };
  }

  take(sessionId: string, id: string): ExecutionSettings | undefined {
    if (sessionId !== this.sessionId) return undefined;
    const settings = this.calls.get(id);
    this.calls.delete(id);
    return settings;
  }
}
