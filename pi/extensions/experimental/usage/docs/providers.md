# Provider support

The usage extension reads credentials already configured for pi and uses them only to request account usage from supported providers. It does not store or transmit credentials anywhere else.

| Provider       | Usage source              |
| -------------- | ------------------------- |
| Anthropic      | Anthropic OAuth usage API |
| GitHub Copilot | GitHub Copilot usage API  |
| Kimi           | Moonshot usage API        |
| OpenAI Codex   | OpenAI usage API          |
| OpenCode Go    | OpenCode Go usage API     |
| Radius         | Radius live billing API   |
| xAI            | xAI management API        |
| Z.ai           | Z.ai monitor usage API    |

Provider APIs and response formats are not stable public contracts, so a provider can temporarily stop working after an upstream change. `/usage refresh` bypasses the local cache when checking a failure.

## Codex limits

As verified against Codex `36f0dbe796d9bb1a18a0fc0640ed08b3e1d54564` on 2026-09-13, `/usage` reports ordinary included-usage eligibility separately from credits. An absent eligibility field means unknown; a positive credit balance does not change an explicit unavailable result.

The active footer shows the most-used ordinary window and marks ordinary usage unavailable when the backend says so. Optional footer details show the remaining ordinary windows. `/usage` shows all ordinary windows, eligibility, and credits. Additional model-specific quotas returned by the API are ignored.

The reader is passive: it sends only a usage GET with bearer and account headers. It does not send the Luna Reserve opt-in header, activate Reserve, or consume Reserve/reset credits. Account changes clear cached usage and fence in-flight responses; ordinary same-account refreshes retain useful cached results on transient failures. The in-memory snapshot requires no migration.

Source contract: [usage client](https://github.com/openai/codex/blob/36f0dbe796d9bb1a18a0fc0640ed08b3e1d54564/codex-rs/backend-client/src/client/rate_limit_resets.rs).

## OpenRouter credits

OpenRouter reads the account credit summary from `https://openrouter.ai/api/v1/credits` with the configured API key. The active footer shows the remaining credit balance (total credits minus total usage); the balance can go negative on pay-as-you-go accounts that overspend. OpenRouter exposes no time-boxed quota windows on this endpoint, so `/usage` shows only the credit balance.

## Radius accounting

Radius reads the effective `radius` provider's live `/v1/billing` summary with either its OAuth credential or `RADIUS_API_KEY`. The active footer shows available USD balance; optional details show total balance, reserved funds, and finalized current-month spend. Reservations settle asynchronously, so available balance can change as reserved capacity becomes an actual charge and can temporarily be negative.

The integration accepts one unambiguous HTTP(S) gateway from the provider's model catalog. It sends no billing request when the gateway cannot be determined safely. Providers registered under IDs other than `radius` are not discovered. Radius usage does not query delayed analytics exports or turn organization budgets into percentage quotas.
