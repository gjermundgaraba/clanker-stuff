// Provider registration and the session lifecycle around it.
//
// Registration policy across extension evaluations (a subagent session can load the
// extension fresh): the first evaluation registers at load, which puts the models in
// the picker before any session starts. Later ones decide at session_start, when the
// session's model registry shows who owns it:
// - The registry already has the provider (the host passed the parent's registry down):
//   skip. Re-registering would replace the parent's stream function with this
//   evaluation's empty-state one, and the parent's next tool-result delivery would route
//   into it.
// - The registry lacks it (the host gave the child its own): register, or every
//   claude-bridge model in the child fails with "Model not found". A per-evaluation stream
//   in a per-evaluation registry is self-consistent.
// On session_shutdown (including /reload) the first evaluation gives the slot up, so a
// freshly loaded one can register as first again.

import type {
  ExtensionAPI,
  ExtensionContext,
  ProviderConfig,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import type { Bridge } from "./bridge.js";
import { debug } from "./log.js";
import { applyLongContext, catalogModels } from "./models.js";
import { forgetSessionCwd, rememberSessionCwd } from "./session/cwd.js";
import { PROVIDER_ID } from "./session/convert.js";
import { shared } from "./shared.js";
import { createProviderStream } from "./stream.js";
import type { ProviderStream } from "./stream.js";

/** Fan a history rewrite out to every evaluation in the process; exactly one serves
 *  provider traffic for any given pi session, and only its state matches the id. */
export function forwardRewrite(piSession: string, event: string): void {
  for (const hook of shared().markRebuildHooks) hook(piSession, event);
}

export class BridgeLifecycle {
  private readonly stream: ProviderStream;

  private readonly providerConfig: ProviderConfig;

  /** Problems to show once a session's UI is available. */
  private notices: string[] = [];

  private deferredRegistration = false;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly bridge: Bridge,
  ) {
    const models = applyLongContext(catalogModels());

    if (models.length === 0) {
      this.notices.push(
        "claude-bridge: pi-ai's Anthropic catalog has no models; update @earendil-works/pi-ai",
      );
    }

    this.stream = createProviderStream(bridge);
    this.providerConfig = {
      baseUrl: PROVIDER_ID,
      apiKey: "not-used",
      api: PROVIDER_ID,
      models,
      streamSimple: this.stream,
    };
    shared().markRebuildHooks.add((piSession, event) => bridge.markRebuild(piSession, event));
  }

  registerProvider(): void {
    const state = shared();

    if (state.activeStream === undefined) {
      state.activeStream = this.stream;
      this.pi.registerProvider(PROVIDER_ID, this.providerConfig);
    } else {
      debug("provider: deferring registration decision to session_start");
      this.deferredRegistration = true;
    }
  }

  sessionStart(event: SessionStartEvent, ctx: ExtensionContext): void {
    this.bridge.attachUi(ctx.ui);
    rememberSessionCwd(ctx.sessionManager.getSessionId(), ctx.cwd);

    for (const notice of this.notices) this.bridge.notify(notice);

    this.notices = [];

    if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
      this.clearSessions(`session_start:${event.reason}`);
    }

    if (!this.deferredRegistration) return;

    if (ctx.modelRegistry.getProvider(PROVIDER_ID) === undefined) {
      debug(`provider: registry lacks ${PROVIDER_ID}, registering`);
      this.pi.registerProvider(PROVIDER_ID, this.providerConfig);
    } else {
      debug(`provider: registry already has ${PROVIDER_ID}, skipping registration`);
    }
  }

  sessionShutdown(ctx: ExtensionContext): void {
    forgetSessionCwd(ctx.sessionManager.getSessionId());
    this.bridge.reportLeaks("session_shutdown");
    this.clearSessions("session_shutdown");
  }

  // Every mirror goes: children never emit session_shutdown (only runtime teardown and
  // /reload do), so the top-level transition takes all of them.
  private clearSessions(event: string): void {
    debug(`${event}: clearing ${this.bridge.mirrors.size} shared session(s)`);
    this.bridge.mirrors.clear();

    const state = shared();

    if (state.activeStream === this.stream) {
      debug(`${event}: giving up the registered provider slot`);
      state.activeStream = undefined;
    }
  }
}
