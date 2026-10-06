# Fast operating guide

Fast is experimental. It requests `service_tier: "priority"` through Pi's native OpenAI Responses provider. It is best effort: an accepted request may run at the default tier, and some models or accounts may reject priority. There is no model allowlist or capability qualification prerequisite.

## Use and scope

- `/fast` toggles only the current runtime's local state. It takes no arguments and never writes configuration.
- Every normally discovered Fast runtime reads its own configuration snapshot at session start or reload, including headless and delegated runtimes. Existing runtimes do not follow changes to the file or another runtime's toggle.
- `--fast` enables only the initial startup runtime. It is not inherited by children or reapplied on reload; reload resets local toggles and reads configuration again.

To choose a startup default, maintain `~/.pi/agent/fast.json` yourself:

```json
{ "fast": true }
```

The `fast` property is required and must be a boolean. Extra properties are allowed and ignored. A missing file means off. Invalid or unreadable configuration produces a warning and uses the initial startup flag, or off when that flag does not apply. The extension never creates or writes this file. External edits affect the next session start or reload, not a live runtime.

Install the local package into personal or trusted project settings for ordinary Pi discovery, including delegated runtimes. A one-off `-e pi/extensions/experimental/fast/index.ts` load is local to that root runtime and does not propagate to children. Fast uses no root-to-child adapter. See [delegated resources](https://github.com/gjermundgaraba/clanker-stuff/blob/main/pi/extensions/experimental/subagents/docs/protocols.md) for child resource loading.

## Request boundary

Both the selected model and registry-resolved metadata must identify `openai/openai-responses` at exactly `https://api.openai.com/v1`. Authentication must be subscription OAuth, not an API key. The outgoing payload model must match the selected ID. Eligible model IDs are otherwise unrestricted.

When off or ineligible, Fast leaves the payload unchanged. It does not change providers, endpoints, auth, model choice or routing headers. Backend rejection surfaces normally; Fast adds no retry or fallback.

The indicator **⚡ Fast requested** remains visible whenever this runtime has Fast enabled, even outside native subscription priority routing. It expresses intent only. It does not confirm the server's processing tier, entitlement, latency improvement or billing. Production does not observe or publish server tiers.

## Developer diagnostics

The [unpackaged scripts](https://github.com/gjermundgaraba/clanker-stuff/tree/main/pi/extensions/experimental/fast/scripts) remain useful for checking serialized intent, server confirmation, native auth and no-retry safety. They do not qualify models for production. They make real authenticated inference calls; run from a repository checkout only with authorization:

```bash
node pi/extensions/experimental/fast/scripts/verify.ts [MODEL_ID] [default|priority|fast]
```

The diagnostic default is the literal `gpt-6.1-sol`, not an allowlist. The probe uses native transport, verifies the serialized endpoint/model/tier, preserves auth, sets `maxRetries: 0`, and separates request success from terminal `priority`/`fast` confirmation. Never infer processing tier from HTTP success, cost estimates or one timing comparison. Historical results are in [the repository verification record](https://github.com/gjermundgaraba/clanker-stuff/blob/main/pi/extensions/experimental/fast/docs/verification.md), not an admission rule.
