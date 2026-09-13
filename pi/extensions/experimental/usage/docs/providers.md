# Provider support

The usage extension reads credentials already configured for pi and uses them only to request account usage from supported providers. It does not store or transmit credentials anywhere else.

| Provider       | Usage source              |
| -------------- | ------------------------- |
| Anthropic      | Anthropic OAuth usage API |
| GitHub Copilot | GitHub Copilot usage API  |
| Kimi           | Moonshot usage API        |
| MiniMax        | MiniMax usage API         |
| MiniMax CN     | MiniMax usage API         |
| OpenAI Codex   | OpenAI usage API          |
| OpenCode       | CodexBar history file     |
| xAI            | xAI management API        |
| Z.ai           | Z.ai monitor usage API    |

Provider APIs and response formats are not stable public contracts, so a provider can temporarily stop working after an upstream change. `/usage refresh` bypasses the local cache when checking a failure.

## Codex limits

As verified against Codex `36f0dbe796d9bb1a18a0fc0640ed08b3e1d54564` on 2026-09-13, `/usage` reports ordinary included-usage eligibility separately from credits. An absent eligibility field means unknown; a positive credit balance does not change an explicit unavailable result. Additional quotas retain their metered-feature identity, display label, associated normal-model slug when supplied, and their own primary/secondary windows. Quotas with the same reset period are displayed separately.

The active footer shows the most-used ordinary window and marks ordinary usage unavailable when the backend says so. Optional footer details include additional model-specific windows with their quota and model labels; they do not silently replace the ordinary window. `/usage` shows all additional limits, including quotas whose windows are absent.

The reader is passive: it sends only a usage GET with bearer and account headers. It does not send the Luna Reserve opt-in header, activate Reserve, or consume Reserve/reset credits. Account changes clear cached usage and fence in-flight responses; ordinary same-account refreshes retain useful cached results on transient failures. The in-memory snapshot requires no migration.

Source contracts: [usage client](https://github.com/openai/codex/blob/36f0dbe796d9bb1a18a0fc0640ed08b3e1d54564/codex-rs/backend-client/src/client/rate_limit_resets.rs), [additional model metadata](https://github.com/openai/codex/blob/36f0dbe796d9bb1a18a0fc0640ed08b3e1d54564/codex-rs/backend-client/src/types.rs), and [quota payload](https://github.com/openai/codex/blob/36f0dbe796d9bb1a18a0fc0640ed08b3e1d54564/codex-rs/codex-backend-openapi-models/src/models/additional_rate_limit_details.rs).
