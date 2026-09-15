# Recap configuration

Recap requires a global config file at `<agent-dir>/recap.json`, normally `~/.pi/agent/recap.json`:

```json
{
  "model": {
    "provider": "provider-id",
    "id": "model-id"
  },
  "thinking": "low"
}
```

Use a model already available to Pi with working provider authentication. The format is strict: both strings must be non-empty and unknown fields are rejected.

`thinking` is optional and accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Omit it to preserve the native model/provider defaults; it never inherits the active session's thinking level. When set, Pi clamps the requested level to the recap model's supported levels and the registered provider translates it to its native thinking options. `off` requests no reasoning where the model supports it; models that require thinking may clamp it upward. Non-reasoning models use `off`.

Higher thinking can increase latency and token usage. The hard 30-second deadline still applies. Recap does not specify an output-token limit; model/provider defaults apply. A low level is usually sufficient for these short recaps.

Recap sends the full eligible user and assistant text from up to eight recent user turns, without a prompt byte limit. Before sending, Pi estimates the complete prompt's token count. If it reaches or exceeds the model's known context window, recap skips that snapshot instead of truncating it. The estimate is approximate; requests below it can still overflow due to tokenization or output/reasoning requirements. The requested 40-word length and hard 320-character display limit remain unchanged.

The configured model is used only for recap generation. Recap never falls back to the active conversation model. A missing or invalid config, unknown model, or unavailable startup authentication prevents initialization and produces one notification.

Each eligible snapshot gets one completion attempt, with no extension-level retry. An oversized prompt, provider failure, timeout, or unusable response produces one warning and suppresses repeated attempts for that unchanged snapshot; it does not disable later recaps. A changed conversation revision or prompt can generate again. Cancellation and stale results are discarded silently. Starting or reloading a session clears the in-memory failure suppression, while successful recap deduplication remains durable.

The file is read when a session starts or reloads. Reload Pi after changing it.
