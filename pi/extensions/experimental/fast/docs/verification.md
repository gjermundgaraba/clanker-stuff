# Native verification record

Historical authorized checks on 2026-10-05 record request behavior, not guaranteed processing tier or speed. They are not production admission prerequisites; current best-effort operation is in [behavior.md](behavior.md).

The native model catalog is version-sensitive. The earlier unversioned request returned seven entries and only Astra among these GPT-6 IDs; that was an incomplete basis for excluding 6.1. Adding `client_version=1.0.3`, the actual installed Pi version, returned ten entries, including `gpt-6.1-sol` with `service_tiers: [{ "id": "priority", "name": "Fast" }]`, `default_service_tier: null` and `minimal_client_version: "0.153.0"`. Native catalog records use `models[]` and `slug`, unlike the generic API-key model-list shape. Direct model-retrieval endpoints returned HTTP 403 even for Astra and are not an availability discriminator for this grant.

[OpenAI's native ChatGPT-plan inference documentation](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) explicitly uses `gpt-6.1-sol` at the same public Responses endpoint. Its [model documentation](https://developers.openai.com/api/docs/models/gpt-6.1-sol) also advertises Fast. The account-specific versioned metadata and completed native priority request were historical capability evidence; the model name is canonical, without an alias or endpoint change. Production now uses the native endpoint/auth gate without a model allowlist.

## Native verification findings

Authorized native Pi 1.0.3 checks on 2026-10-05 used `openai/gpt-6.1-sol`. The first two rounds each compared standard and priority requests, with and without Codex-style routing headers; all four terminal responses reported `default`. The substantive follow-up used the same code-review prompt and medium thinking for both request spellings:

| Requested tier | Actual wire tier | HTTP | Terminal reported tier | Outcome                                                                                                                |
| -------------- | ---------------- | ---- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `priority`     | `priority`       | 200  | `default`              | Completed normally: 174 input tokens, 818 output tokens including 262 reasoning tokens; Fast processing not confirmed. |
| `fast`         | `fast`           | 400  | None                   | Rejected: `Unsupported service_tier: fast`; no generated tokens.                                                       |

One additional diagnostic request repeated only the rejected `fast` spelling and confirmed the same HTTP 400 reason. The endpoint and serialized model/tier were checked before sending. This route did not honor the generic API documentation's request-alias behavior for this authentication/model combination. The production extension sends only `priority`, never the `fast` request spelling.

A subsequent substantive standard/priority control used the advertised Astra model:

| Requested tier | Actual wire tier | HTTP | Terminal reported tier | Tokens (input / output) | Elapsed |
| -------------- | ---------------- | ---- | ---------------------- | ----------------------- | ------- |
| `default`      | `default`        | 200  | `default`              | 174 / 734               | 31.96 s |
| `priority`     | `priority`       | 200  | `default`              | 174 / 799               | 21.75 s |

Both Astra requests completed normally with useful code reviews. The completed priority requests plus versioned native capability metadata supported the former qualification policy for 6.1 Sol and Astra; that policy is no longer a prerequisite. Actual Fast processing remains unconfirmed: neither the faster single request nor estimated cost establishes it. No documented reporting defect was found.

## Codex routing comparison

At the referenced Codex checkout, `protocol/src/config_types.rs` maps Fast to `priority`; `core/src/client.rs` adds the model/tier routing hint for Codex-backend requests, and `login/src/auth/default_client.rs` defines its default originator. However, `model-provider-info/src/lib.rs` selects `https://chatgpt.com/backend-api/codex` for ChatGPT subscription authentication. Native Pi 1.0.3 instead uses `https://api.openai.com/v1` with its own subscription authentication. Copying the routing headers does not reproduce that different backend or establish priority support on Pi's endpoint. Fast does not replace either the native endpoint or authentication.

[OpenAI's Fast-mode guide](https://developers.openai.com/api/docs/guides/fast-mode) documents `fast` and `priority` as equivalent request values for supported models. Pi 1.0.3 handles both reported tier names natively. Recently updated native-provider extensions use the same payload hook: [pi-codex-fast added native OpenAI models on 2026-09-30](https://github.com/calesennett/pi-codex-fast/pull/17), while [this native-subscription extension](https://github.com/10knamesmore/dotfiles/blob/2ef953f2d2e8055f8350eb2b7437ba64becd4e3d/pi/src/extensions/openai-fast/extension.ts) deliberately distinguishes Fast requested from the server's reported tier. Those implementations establish a request pattern, not entitlement or confirmed processing for this account. An [independent native-provider report on 2026-10-02](https://github.com/nijaru/pi-fast-mode/issues/1) also describes advertised priority/Fast, accepted priority requests, rejected `fast` requests and completed responses reporting `default`. It asserts faster output but supplies no raw timing dataset, usage-charge comparison or explanation of the reported tier.
