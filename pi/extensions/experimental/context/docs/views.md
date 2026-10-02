# Inspector views

`/context` opens a snapshot on **State**. Press v to switch to **Request** or back, including from a detail view. Each view preserves its own search, scroll, and selected details. While typing a search, v remains a search character.

## State

State shows Pi-side system prompt, tool declarations, and retained messages with original/effective content and edit provenance. It does not include transient context-hook changes. Token estimates count effective content only and remain separate from Pi context usage.

## Request

In TUI mode, the extension automatically snapshots the latest `before_provider_request` payload from session start, without requiring the inspector to be opened. It includes transient context and tool-loadout projections applied before that hook.

This is **not guaranteed to be the final wire request**: later extensions and provider transport can change it. Payload bytes are not context-token usage, so Request has no token estimates or usage bar.

Only the latest capture is kept. Captures clear on session start, tree navigation, or shutdown; opening or closing the inspector does not enable or disable capture. If no request has been observed on this branch, Request shows an empty state rather than reconstructing a payload from stored history.

## Privacy and bounds

Captures are memory-only and never appended to session history. Ordinary JSON serialization produces independent text without retaining the original payload object. Serialization can invoke getters and `toJSON`; cycles, throwing accessors, and other unserializable inputs produce an inspection-failure message.

Each retained capture is bounded to 1 MiB of UTF-8 text. Complete serialized payloads that fit are retained without separate depth, child-count, or string limits. Larger payloads become labeled text previews rather than valid JSON. The cap limits retained text, not peak serialization memory or traversal work.

Recognizable base64 media and common credential-named string values are omitted. Credential-named schema objects and other non-string declarations are preserved. This is best-effort omission, not a security boundary: compound credentials, schema examples/defaults, prompts, tool results, embedded JSON strings, URLs, and unrecognized fields may still contain secrets.

The y key copies the selected view content to the clipboard. Redacted or truncated information cannot be recovered through the inspector.
