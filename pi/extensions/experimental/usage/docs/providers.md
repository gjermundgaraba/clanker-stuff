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

## Native OpenAI

Subscription-quota reporting is unavailable for native `openai`. The footer omits that quota; `/usage` explains the unsupported integration when OpenAI is selected. This is not a login failure and does not affect native session token/cost accounting.

The retired `openai-codex` WHAM reader and its ChatGPT cookie transport are removed. Native API keys and resource-scoped subscription grants are not sent to that endpoint. Native quota support requires verified endpoint and grant compatibility; inference support does not establish quota support.

## OpenRouter credits

OpenRouter reads the account credit summary from `https://openrouter.ai/api/v1/credits` with the configured API key. The active footer shows the remaining credit balance (total credits minus total usage); the balance can go negative on pay-as-you-go accounts that overspend. OpenRouter exposes no time-boxed quota windows on this endpoint, so `/usage` shows only the credit balance. OpenRouter documents this endpoint as requiring a management key; with a key it rejects (HTTP 403), OpenRouter is reported as unavailable rather than failed.

## Radius accounting

Radius reads the effective `radius` provider's live `/v1/billing` summary with either its OAuth credential or `RADIUS_API_KEY`. The active footer shows available USD balance; optional details show total balance, reserved funds, and finalized current-month spend. Reservations settle asynchronously, so available balance can change as reserved capacity becomes an actual charge and can temporarily be negative.

The integration accepts one unambiguous HTTP(S) gateway from the provider's model catalog. It sends no billing request when the gateway cannot be determined safely. Providers registered under IDs other than `radius` are not discovered. Radius usage does not query delayed analytics exports or turn organization budgets into percentage quotas.

`/usage` queries available accounts and survives model changes and routine footer refreshes. Controller shutdown suppresses late command delivery. Footer updates remain fenced against obsolete refreshes.
