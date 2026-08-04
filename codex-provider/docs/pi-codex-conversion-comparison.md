# Handoff: `codex-provider` versus `pi-codex-conversion`

Purpose: give an independent reviewer enough evidence to decide whether the local provider should be replaced, combined with, or selectively updated from Igor Warzocha's package.

## Context

The original questions were:

1. “How does `codex-provider/` compare with `https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/main/packages/pi-codex-conversion`?”
2. “Is there anything from `pi-codex-conversion` that it does better than `codex-provider` among the features both support?”

The second question said `pi-codex-conversations`; this report assumes that was a typo for `pi-codex-conversion`.

Baselines inspected on 2026-08-03:

- Local repository: this repository, branch `main`, commit `641ecec9e274cf718d0bc83f26279d2c953fbcc8`.
- OpenAI Codex parity authority: cached `openai/codex`, commit [`6219b7c40fc9c702c0aef9964e72b492558f60e4`](https://github.com/openai/codex/tree/6219b7c40fc9c702c0aef9964e72b492558f60e4), dated 2026-07-30.
- Remote comparison package: `IgorWarzocha/howaboua-pi-stuff`, branch `main`, commit [`b3591d996efbf6df293e426dea2bb2dd17fcbfe6`](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/b3591d996efbf6df293e426dea2bb2dd17fcbfe6), also tagged `@howaboua/pi-codex-conversion@3.0.7`.
- Pi host contract: `earendil-works/pi`, tag `v0.83.0`, commit [`845d6ff1f6643aba440341cce877ce1c43ebbc39`](https://github.com/earendil-works/pi/tree/845d6ff1f6643aba440341cce877ce1c43ebbc39).

The cached OpenAI Codex checkout is the authority for behavioral parity: its remote-compaction construction, turn loop, and transport session are the reference behavior. The remote package is evidence for candidate Pi adaptations, not a second parity authority. Evidence: [Codex remote compaction](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/core/src/compact_remote_v2.rs#L201-L572), [turn loop](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/core/src/session/turn.rs#L1338-L1407), and [transport selection](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/core/src/client.rs#L1740-L1867).

## Current state

`codex-provider` is a focused replacement for Pi's `openai-codex` provider. It owns request construction, SSE/WebSocket transport, model metadata, turn and continuation state, remote compaction V2, and durable checkpoint replay. It supports Pi 0.83.0 and requires an audited load-last local installation; npm installation is unsupported. Evidence: [local README](../README.md), [design](design.md), and [deployment contract](local-deployment.md).

`pi-codex-conversion` is a broader public Codex-oriented distribution for Pi. It also replaces the OpenAI Codex provider and offers remote compaction, but adds Codex-shaped tools, Responses Lite Code Mode, web and image tools, voice/dictation, a LAN UI, settings, usage display, and configured-provider support. Evidence: [remote README](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/b3591d996efbf6df293e426dea2bb2dd17fcbfe6/packages/pi-codex-conversion/README.md#L30-L53) and [package manifest](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/b3591d996efbf6df293e426dea2bb2dd17fcbfe6/packages/pi-codex-conversion/package.json#L1-L105).

The meaningful overlap is the OpenAI Codex provider, cached transport, Responses request handling, remote compaction V2, and opaque-history replay. Most of the remote package is outside the local package's intended scope.

## Findings and evidence

### 1. Keep the local architecture, and do not co-load the packages

Both packages register ownership of `openai-codex` and intercept provider requests and Pi compaction events. Local ownership is registered in [lifecycle.ts](../lifecycle.ts). Remote ownership is registered in [`register.ts`](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/b3591d996efbf6df293e426dea2bb2dd17fcbfe6/packages/pi-codex-conversion/src/extension/register.ts#L14-L51) and [`openai-codex-custom-provider.ts`](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/b3591d996efbf6df293e426dea2bb2dd17fcbfe6/packages/pi-codex-conversion/src/providers/openai-codex-custom-provider.ts#L427-L443).

Co-loading makes provider and hook behavior depend on registration order and violates the local final-extension deployment contract. Replacing the local architecture would also lose dynamic Codex model metadata, context-window generations, strict checkpoint provenance, and transition-aware compaction. Evidence: [provider model refresh](../provider.ts), [window runtime](../provider.ts), [checkpoint design](design.md), and [model-transition research](provider-replacement-research.md).

### 2. The remote retry loop is broader, but unsafe to port as-is

The remote default is five retries after the initial request: six total attempts, not five. Overload and rate-limit recovery each have a separate 180,000 ms wait budget. It retries eligible WebSocket and SSE failures even after output began, resets its authoritative partial response between attempts, falls back to SSE for selected WebSocket failures, and attaches transport diagnostics. Evidence: [remote retry loop](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/b3591d996efbf6df293e426dea2bb2dd17fcbfe6/packages/pi-codex-conversion/src/providers/openai-codex-custom-provider.ts#L286-L410) and [remote constants](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/b3591d996efbf6df293e426dea2bb2dd17fcbfe6/packages/pi-codex-conversion/src/providers/openai-codex/constants.ts#L3-L19).

Pi `AgentSession` already enables three outer retries by default, meaning four session attempts. Applying six internal attempts to a visible normal stream can therefore produce up to 24 upstream attempts for one logical call. Evidence: [Pi retry defaults](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/settings-manager.ts#L813-L820) and [Pi retry loop](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/agent-session.ts#L2668-L2710).

Resetting a normal assistant response after user-visible emission is not safe under Pi 0.83.0. Pi forwards message-update events to extensions and consumers; there is no event that retracts already emitted deltas. Resetting also drops failed-attempt usage from the eventual assistant message, so provider-reported usage can understate paid work. Evidence: [Pi event forwarding](https://github.com/earendil-works/pi/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/coding-agent/src/core/agent-session.ts#L720-L750) and [remote output reset](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/b3591d996efbf6df293e426dea2bb2dd17fcbfe6/packages/pi-codex-conversion/src/providers/openai-codex-custom-provider.ts#L300-L382).

Private remote-compaction streams are different: their partial events are consumed internally and never emitted as assistant output. Both current Codex and the local provider intentionally retry eligible compaction failures; local success requires a completed stream, response ID, usage, and exactly one compaction item. Evidence: [Codex compaction retry](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/core/src/compact_remote_v2.rs#L328-L375) and [local compaction loop](../provider.ts).

For normal assistant output, the local provider defaults internal retries to zero, never retries after its first user-visible event, and performs session-sticky WebSocket-to-SSE fallback before output. Private compaction exhausts three pre-output WebSocket attempts before switching the session to SSE because no partial output escaped. Preserve those boundaries. Evidence: [local SSE policy](../provider.ts), [local transport branch](../provider.ts), and [fallback canary](live-canary.md).

The other bounded improvements worth adopting are exact context-limit/compaction classification, reliable signaling to Pi when an outer retry is safe, and sanitized fallback diagnostics. Do not add a second general retry policy for visible assistant streams.

### 3. Marker-based contextual filtering is not safe local policy

The remote package removes user content by matching textual wrappers such as `# AGENTS.md instructions`, `<environment_context>`, `<skill>`, and several custom markers. Evidence: [remote retained-history filtering](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/b3591d996efbf6df293e426dea2bb2dd17fcbfe6/packages/pi-codex-conversion/src/adapter/compaction/remote-v2-history.ts#L1-L130).

That heuristic should not be copied. By the time the local extension receives finalized provider input, custom injected content has no trusted provenance: real user text can match the same markers, while custom context can use different markers. Standard Pi AGENTS and request-context state is already carried outside the retained user-message segment, so filtering it again adds no benefit. The local implementation instead proves marker-free structural parity over the complete finalized input. Evidence: [context-alignment invariant](context-alignment.md), [retained finalized-input parsing](../lifecycle.ts), [request-state exclusion](../lifecycle.ts), and [system-prompt construction](../provider.ts).

Only add contextual filtering if a future Pi API preserves trusted producer/provenance metadata through finalization. Text markers alone are insufficient.

### 4. Do not adopt a fixed 372,000-token budget or `js-tiktoken` yet

The remote package uses `o200k_base` tokenization when shrinking oversized compaction requests and a fixed 372,000-token Responses Lite compaction budget. Evidence: [remote request shrinker](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/b3591d996efbf6df293e426dea2bb2dd17fcbfe6/packages/pi-codex-conversion/src/adapter/compaction/request-shrink.ts#L1-L112).

The local implementation uses UTF-8 bytes divided by four, a fixed image estimate, and the effective model window. Its real-window SSE canary records metadata-only estimator evidence from each round's latest compaction request: the local estimate, provider-reported prompt-side usage, their ratio, model/window metadata, Responses Lite state, and rewritten-output count. It excludes prompt text, tool arguments, encrypted content, credentials, headers, URLs, payloads, and request sizes. Evidence: [local estimator](../replay.ts) and [real-window canary contract](live-canary.md).

No durable evidence yet justifies a new tokenizer dependency or hard-coded larger budget. Run the canary across representative windows and revisit the estimator only if repeated results show material truncation or attributable overflow.

### 5. Compaction failure policy is configurable locally

The remote package can preserve its previous opaque window and let Pi textual summarization run after eligible remote-compaction failure. Evidence: [remote compaction fallback](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/b3591d996efbf6df293e426dea2bb2dd17fcbfe6/packages/pi-codex-conversion/src/adapter/compaction/compaction.ts#L247-L313).

The local package is not limited to unconditional fail-closed cancellation. `CLANKER_CODEX_COMPACTION_FAILURE=ask|fallback|cancel` selects an explicit portable-summary policy; `ask` is the default, `fallback` installs the already completed portable summary, and `cancel` keeps context unchanged. Unsafe context, stale state, persistence failure, abort, or unavailable UI still cancel. Evidence: [local failure policy](design.md) and [portable-summary contract](portable-compaction-handoff.md).

This is a policy trade-off, not a remote correctness advantage.

## Recommendations

1. Keep `codex-provider` as the provider/checkpoint architecture and keep the packages mutually exclusive.
2. Preserve provider retry default `0` and no post-emission retry for visible assistant output. Keep private compaction's bounded three-attempt WebSocket budget followed by sticky SSE. Also retain exact compaction classification, reliable Pi outer-retry signaling, and sanitized fallback diagnostics.
3. Do not add marker-based contextual filtering, a fixed 372,000-token budget, or `js-tiktoken` without trusted provenance or canary evidence.
4. Keep the existing `ask|fallback|cancel` portable-summary policy.

Do not import the remote package's tools, Code Mode, voice, UI, or native binaries unless those capabilities become explicit requirements.

## How to verify or reproduce

Run these commands from any directory.

### Confirm the exact baselines

```bash
git -C /Users/gg/code/priv/clanker-extensions rev-parse HEAD
git -C /Users/gg/.cache/checkouts/github.com/openai/codex \
  show -s --format='%H %cs' 6219b7c40fc9c702c0aef9964e72b492558f60e4
git -C /Users/gg/.cache/checkouts/github.com/IgorWarzocha/howaboua-pi-stuff rev-parse HEAD
git -C /Users/gg/.cache/checkouts/github.com/earendil-works/pi describe --tags --exact-match HEAD
```

Expected output:

```text
641ecec9e274cf718d0bc83f26279d2c953fbcc8
6219b7c40fc9c702c0aef9964e72b492558f60e4 2026-07-30
b3591d996efbf6df293e426dea2bb2dd17fcbfe6
v0.83.0
```

### Confirm ownership, retry boundaries, and failure policy

```bash
rg -n 'refreshModels|currentWindowId|registerProvider|maxRetries = options.*0|CLANKER_CODEX_COMPACTION_FAILURE' \
  /Users/gg/code/priv/clanker-extensions/codex-provider

git -C /Users/gg/.cache/checkouts/github.com/IgorWarzocha/howaboua-pi-stuff \
  grep -n -E 'DEFAULT_STREAM_MAX_RETRIES|RECOVERY_BUDGET|CONTEXTUAL_USER_MARKERS|372_000' \
  b3591d996efbf6df293e426dea2bb2dd17fcbfe6 -- \
  packages/pi-codex-conversion/src

rg -n 'maxRetries: this.settings.retry.*3' \
  /Users/gg/.cache/checkouts/github.com/earendil-works/pi/packages/coding-agent/src/core/settings-manager.ts
```

Before implementing a recommendation, run the package-scoped unit and integration suites specified in [AGENTS.md](../../AGENTS.md).

## Open questions

1. **Can Pi expose trustworthy retry and provenance metadata?** Without it, leave outer-retry decisions conservative and contextual filtering disabled.
2. **Does live metadata justify changing the estimator or window?** Run the existing canary across representative windows; change policy only after attributable context-limit failures or material truncation.

## Appendix: scope excluded from the comparison

The following `pi-codex-conversion` capabilities have no local counterpart and were not scored as better or worse shared features:

- Codex-shaped shell, patch, web, image, and view tools.
- GPT-5.6 Responses Lite Code Mode and custom TOML tools.
- Voice, dictation, and the GipPity LAN interface.
- `/codex` settings and usage UI.
- Additional OpenAI Responses-compatible provider support.

No implementation behavior was changed by this comparison document.
