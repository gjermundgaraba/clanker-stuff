# Inspector views

`/context` opens a snapshot on **State**. Press v to cycle through **State**, **Request**, and **Tools**, including from a detail view. Each view preserves its own search, scroll, and selected details. While typing a search, v remains a search character.

## State

State shows Pi's canonical session context: the system prompt and tool declarations replayed from the transcript's system messages, and the retained messages with original/effective content and edit provenance. Declarations are those the latest request recorded, including `prepareLoadout` descriptions; prompt or tool changes since then appear after the next request. Before the first request, State shows the pending system prompt and no tool declarations. Declarations a loadout hides from requests remain listed, because the transcript still declares them.

State does not include transient context-hook changes. The bar shows Pi's measured context usage; the legend's per-section token counts are estimates of effective content only.

## Request

In TUI mode, the extension automatically snapshots the latest `before_provider_request` payload from session start, without requiring the inspector to be opened. It includes transient context and tool-loadout projections applied before that hook.

This is **not guaranteed to be the final wire request**: later extensions and provider transport can change it. With cache warming enabled, the latest payload may be a cache-warming replay of the previous request. Payload bytes are not context-token usage, so Request has no token estimates or usage bar.

Only the latest capture is kept. Captures clear on session start and tree navigation; opening or closing the inspector does not enable or disable capture. If no request has been observed since then, Request shows an empty state rather than reconstructing a payload from stored history.

## Tools

Tools snapshots `getAllTools()` and `getActiveTools()` each time the inspector opens. It shows every registered tool's name, description, parameter schema, exposure, activation, source information, annotations, and namespace metadata, including aliases. Reopen to refresh; it does not capture inventory on each provider request.

Registration, activation, model declaration, and nested-call access are different facts. Direct tools are callable from Code Mode's `tools` only while active; `codemode` and `deferred` tools remain callable without model activation. Model-only and hidden tools are never callable from `tools`. Loadouts can hide or transform active declarations, so this inventory is not a list of what the model received: use State for recorded declarations and Request for the observed request projection.

A `reachesTools` boolean reports whether the tool declares a reachability capability. Inspection does not execute or serialize the callback; it is not an exact dependency list. Tools has no token estimates or context-usage accounting and never changes State's declarations.

## Request capture bounds

Captures are memory-only and never appended to session history. Ordinary JSON serialization produces independent text without retaining the original payload object. Serialization can invoke getters and `toJSON`; cycles, throwing accessors, and other unserializable inputs produce an inspection-failure message.

Each retained Request capture is bounded to 1 MiB of UTF-8 text. Complete serialized payloads that fit are retained without separate depth, child-count, or string limits. Larger payloads become labeled text previews rather than valid JSON. The cap limits retained text, not peak serialization memory or traversal work. Recognizable base64 media is omitted so images do not consume the cap.

Pi's built-in providers keep credentials in request headers, not payloads, so captures are not redacted. Prompts, tool arguments, and tool results are shown as sent and may contain secrets; the y key copies them to the clipboard.
