# Provider support

The usage extension reads credentials already configured for pi and uses them only to request account usage from supported providers. It does not store or transmit credentials anywhere else.

| Provider       | Usage source              |
| -------------- | ------------------------- |
| Anthropic      | Anthropic OAuth usage API |
| GitHub Copilot | GitHub Copilot usage API  |
| Kimi           | Moonshot usage API        |
| OpenCode Go    | OpenCode Go usage API     |
| OpenRouter     | OpenRouter credits API    |
| Radius         | Radius live billing API   |
| xAI            | xAI management API        |
| Z.ai           | Z.ai monitor usage API    |

Provider APIs and response formats are not stable public contracts, so a provider can temporarily stop working after an upstream change. `/usage refresh` bypasses the local cache when checking a failure.

A usage endpoint that answers HTTP 403 means the credential lacks that entitlement, so the provider is reported as unavailable rather than failed. Anthropic and xAI subscription usage requires an OAuth login; API keys are reported as unavailable without a request. When the current target is unavailable, its status says so and `/usage` leads with the reason; other unavailable providers are left out of `/usage`.

## Active provider

The `usage` status line targets a selected physical model's provider immediately, without requiring successful inference. A virtual selection instead targets the current branch's latest identifiable physical assistant attempt, including failed, aborted, and deferred requests, from the end of that turn.

Pending messages and unresolved virtual routing failures are not physical attempts. Before any identifiable physical attempt, a virtual selection has no status, and `/usage` reports that no physical provider has been resolved; the virtual provider namespace is not assumed to identify an account. Startup and tree navigation reconstruct the target from the active branch.

The target is account relevance, not proof of a billable HTTP request. An unsupported target clears the status, and `/usage` explains that quota reporting is unsupported for its provider; no supported provider's older quota is substituted. Native session token/cost accounting is unaffected, and the footer's separate model/thinking history still describes successful completed responses.

The status shows the most-used quota window, or the available balance for accounting providers, and ends with `!` while it shows cached data after a failed refresh. Pi's footer and the footer extension both render it.

## Native OpenAI

Quota reporting is unsupported for native `openai`, as for any provider without a usage integration; this is not a login failure. Native credentials are not sent to any usage endpoint, and inference support does not establish quota support.

## OpenRouter credits

OpenRouter reads the account credit summary from `https://openrouter.ai/api/v1/credits` with the configured API key. The status shows the remaining credit balance (total credits minus total usage); the balance can go negative on pay-as-you-go accounts that overspend. OpenRouter exposes no time-boxed quota windows on this endpoint, so `/usage` shows only the credit balance. OpenRouter documents this endpoint as requiring a management key; other keys are rejected with HTTP 403.

## Radius accounting

Radius reads the effective `radius` provider's live `/v1/billing` summary with either its OAuth credential or `RADIUS_API_KEY`. The status shows available USD balance; `/usage` also shows total balance, reserved funds, and finalized current-month spend. Reservations settle asynchronously, so available balance can change as reserved capacity becomes an actual charge and can temporarily be negative.

The integration accepts one unambiguous HTTP(S) gateway from the provider's model catalog. It sends no billing request when the gateway cannot be determined safely. Providers registered under IDs other than `radius` are not discovered. Radius usage does not query delayed analytics exports or turn organization budgets into percentage quotas.

`/usage` queries available accounts and survives model changes and routine status refreshes. Controller shutdown suppresses late command delivery. Status updates remain fenced against obsolete refreshes.
