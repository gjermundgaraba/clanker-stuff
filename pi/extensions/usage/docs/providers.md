# Provider support

The usage extension reads credentials already configured for pi and uses them only to request account usage from supported providers. It does not store or transmit credentials anywhere else.

| Provider       | Usage source              |
| -------------- | ------------------------- |
| Anthropic      | Anthropic OAuth usage API |
| GitHub Copilot | GitHub Copilot usage API  |
| Kimi           | Moonshot usage API        |
| OpenAI Codex   | OpenAI usage API          |
| OpenCode       | CodexBar history file     |
| xAI            | xAI management API        |

Provider APIs and response formats are not stable public contracts, so a provider can temporarily stop working after an upstream change. `/usage refresh` bypasses the local cache when checking a failure.
