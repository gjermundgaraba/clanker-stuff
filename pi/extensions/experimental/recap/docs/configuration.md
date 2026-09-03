# Recap configuration

Recap requires a global config file at `<agent-dir>/recap.json`, normally `~/.pi/agent/recap.json`:

```json
{
  "model": {
    "provider": "provider-id",
    "id": "model-id"
  }
}
```

Use a model already available to Pi with working provider authentication. The format is strict: both strings must be non-empty and unknown fields are rejected.

The configured model is used only for recap generation. Recap never falls back to the active conversation model. A missing or invalid config, unknown model, or unavailable authentication disables generation for that session and produces one notification.

If generation fails twice without the conversation changing, recap also reports one warning and disables generation for that session. Starting or reloading a session tries the configured model again.

The file is read when a session starts or reloads. Reload Pi after changing it.
