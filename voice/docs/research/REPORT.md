# Codex/ChatGPT Voice vs Pi Voice: runtime research

Date: 28 July 2026

## Refresh: 31 July 2026

The detailed report below is the 28 July baseline, not a description of the current Pi implementation.

The renamed ChatGPT app is now `/Applications/ChatGPT.app`, version `26.727.40816` (build `6067`), with `codex-cli 0.146.0-alpha.9.2`. An exact native call logged on 30 July, after this build was installed, confirms:

- the 12,067-character core prompt is byte-for-byte unchanged;
- the model remains `gpt-live-1-codex`, the voice remains `maple`, and delegation remains `{ "type": "client" }`;
- the session payload shape remains `instructions`, `audio`, `delegation`, `model`, and optional `initial_items`;
- the observed full prompt was longer only because of a dynamic 1,486-character capabilities appendix; and
- the four voice-specific public source files cited below are byte-for-byte identical between `rust-v0.146.0-alpha.3.1` and `rust-v0.146.0-alpha.9.2`.

The current app bundle also contains a rollout-configurable architecture not covered by the baseline:

- an alternate front prompt with `[USER]`/`[BACKEND]` framing and immediate steering of corrections;
- a dedicated voice-coordinator prompt that selects conversation, quick-check, or delegation modes and can dispatch blocking work to worker Codex threads; and
- `new_thread_*`, `default_voice_chat_thread_version`, and `realtime_voice_tools_developer_instructions` configuration keys.

This is static bundle evidence, not observed active behavior. The 30 July call continued the older voice thread created during the baseline capture and still received the unchanged core prompt, so a controlled new-thread capture is required before treating the bundled path as live.

Pi has since adopted the first three implementation implications at the end of this report: the Codex model/voice and post-spawn policy, delegation-bound `commentary`/`speakable` status and completion frames, and mandatory session-context routing. It also added delegation-ID replay protection, unresolved-repeat suppression, terminal companion output, call renewal, and stricter handoff ownership. The old comparisons against `gpt-live-1-boulder-alpha`, the 1,525-character Pi prompt, and the dual unstructured output path are historical.

Current intentional differences are:

1. Pi adapts screen and shared-timeline language to its session, workspace, and terminal.
2. Pi uses the current session as coordinator and serializes delegated requests; ChatGPT's observed path uses a dedicated voice thread and can route a later handoff as steering, while its bundled alternate path can also dispatch worker threads. Pi therefore does not yet deliver a newly delegated correction into an active coordinator turn.
3. Pi suppresses substantially repeated unresolved requests in the live prompt; the current ChatGPT core prompt does not contain that rule.
4. Pi renders substantial output through `present_voice_result`; ChatGPT supports its proprietary `::codex-realtime-inline{}` timeline directive.

Refresh evidence is private under:

```text
~/Library/Application Support/Pi Voice Research/captures/chatgpt-refresh-2026-07-31/evidence
```

The runtime recorder and CLI proxy now default to `/Applications/ChatGPT.app`; `CODEX_APP_PATH` can override the recorder path.

## Bottom line

The two implementations use the same broad architecture:

```text
microphone -> GPT-Live -> delegation.created -> coding coordinator
                                      <- coordinator context/status
```

No client-side deterministic router was observed. The visible implementations use the same delegation protocol, but server-internal routing remains unobservable. The important visible differences are:

1. Codex used `gpt-live-1-codex`, a 12,067-character realtime prompt, and an explicit post-handoff state machine. Pi used `gpt-live-1-boulder-alpha` and a 1,525-character policy.
2. Codex's prompt mandates `SpawnThinking` for screen ambiguity, current state, substantial output, and actions. Pi's prompt did not make screen-context references a special mandatory case.
3. Codex sends coordinator output back as delegation-bound `commentary` or `speakable` frames with `[STATUS]` and `[COMPLETE]` semantics. Pi sends a separate global speakable update and also streams ordinary assistant text back without a channel.
4. Codex creates a dedicated `realtime_voice` coordinator thread. Pi deliberately uses the current Pi session as the coordinator.
5. Both still let GPT-Live decide whether to delegate. Codex was stochastic in the controlled runs too.

The original duplicate steering event is real at the Pi-session boundary. The same 455-character request was inserted twice, 105.980 seconds apart, and the second insertion arrived while Pi was working, so Pi treated it as steering. The old run has no raw sideband IDs or audio, so it cannot establish whether GPT-Live created a new delegation, the service retried one, or the same event was delivered again.

The evidence is more consistent with a later re-delegation than an immediate transport duplicate: the events were almost 106 seconds apart and the second `transcript_delta` had advanced. That remains a hypothesis, not a finding.

## Evidence status

### Directly observed

- Exact signed Codex desktop call request, realtime prompt, model, voice, and protocol configuration.
- Text sideband payloads logged at Codex's send and consumption boundaries.
- Exact app-server RPC messages.
- Recorded Codex coordinator logical inference requests and normalized completed responses, including tools, response IDs, tool calls, and tool results.
- Exact Pi provider requests, tools, model events, sideband frames, and media process messages.
- Microphone-source, microphone-sent, and remote-output WebM recordings for controlled runs.
- Three repeated action/meta runs on each implementation.
- Historical persisted Pi entries from the user's problematic session.

“Exact” in this report means the payload at the named client instrumentation boundary, not proof that every event was retained. Codex rollout tracing is best-effort, may reconstruct a logical request rather than preserve the incremental wire request, and records normalized completed output rather than every stream delta. Native SQLite logging can also drop rows under load.

### Not observable from the client

- GPT-Live server-internal reasoning or routing implementation.
- Server-side account rollout logic beyond the configuration returned to the client.
- Raw RTP packets or TLS plaintext.
- Event IDs and microphone audio from the historical run, because tracing was not enabled then.

## Provenance

### Codex runtime

| Item | Observed value |
| --- | --- |
| Application | `/Applications/Codex.app` |
| Version | `26.721.41059` |
| Build | `5848` |
| Bundle ID | `com.openai.codex` |
| Signing team | OpenAI `2DC432GLL2`, hardened runtime, notarized |
| Executable SHA-256 | `d7bd5eacb7f59c42240e6c5dc62eebdeca9d09a0b59ed4c3ac3e2b55ef8d9336` |
| `app.asar` SHA-256 | `da39a51b06fb4c728d418b8f0f05fc8fd8c6b1f74c4fb4d47c20c7914a798f45` |
| Bundled CLI | `codex-cli 0.146.0-alpha.3.1` |
| CLI SHA-256 | `6d8be49e49751554df16572369e636cbe02c84b208cad3dc35528c846eeca223` |
| Matching public tag | `rust-v0.146.0-alpha.3.1` (annotated tag `1128ef2c0eec791d1c6aeff0ecbb9f3f89b0aab2`) |
| Peeled source commit | `ff75c5b939c477c49eb1bd5248da6dab71b109d1` |

`git ls-remote` resolves that annotated tag to the pinned commit. The installed version, binary strings, and runtime file/line metadata are consistent with the tagged source, but no reproducible-build attestation ties the installed bytes to it.

### Pi runtime

| Item                   | Observed value                           |
| ---------------------- | ---------------------------------------- |
| Pi                     | `v0.82.1`                                |
| Extension              | `@clanker-extensions/voice` `0.1.0`      |
| Coordinator            | Current Pi CLI session                   |
| Test coordinator model | `gpt-5.6-sol`, `xhigh`                   |
| Test working directory | `/Users/gg/code/priv/clanker-extensions` |

## Capture method

### Signed Codex

`voice/research/codex-runtime-recorder.mjs` launched the installed signed app with:

- a DevTools Protocol port;
- a transparent `CODEX_CLI_PATH` launcher around the real bundled CLI;
- `CODEX_ROLLOUT_TRACE_ROOT` for best-effort logical coordinator request/response traces;
- targeted native TRACE logging for the call request and sideband text; and
- in-memory renderer hooks for WebRTC, data channel, and media recording.

The app was not unpacked, patched, or re-signed. The renderer hooks replace selected browser APIs in memory, and the CLI launcher forwards byte-for-byte stdio to the real CLI while recording it. This is an instrumented production runtime, not an untouched baseline.

Native logs were independently exported from `~/.codex/logs_2.sqlite` for the latest captures. The SQLite and proxy/stderr records agree. SQLite has a 512-event non-blocking queue and can drop rows under load, so it is supporting evidence rather than a proof of zero loss.

### Pi

`voice/research/pi-runtime-recorder.ts` ran as an explicit Pi extension. The voice extension's `PI_VOICE_TRACE_DIR` hook recorded:

- call request and response;
- sideband open, incoming, outgoing, error, and close events;
- media parent/child messages;
- Pi session, turn, message, tool, and model events; and
- exact provider request payloads with credentials redacted.

The media process accepted the same synthetic audio files only when the research environment variables were set. Normal extension behavior is unchanged when those variables are absent.

### Stimuli

The exact files and hashes are in:

```text
~/Library/Application Support/Pi Voice Research/stimuli/manifest.json
```

The principal inputs were:

| Scenario          | Spoken input                                           |
| ----------------- | ------------------------------------------------------ |
| Context           | “Do you know what I have been working on here?”        |
| Food then context | Food question, 8 seconds silence, context question     |
| Action then meta  | Git-status action, 8 seconds silence, routing question |
| Silence           | 15 seconds digital silence                             |
| Noise             | 15 seconds pink noise at amplitude `0.003`             |

Every A/B pair used the same stimulus file. Synthetic injection removes room, microphone, and speaker differences, but does not reproduce a physical microphone feedback path.

## Exact realtime configuration

| Setting | Codex | Pi |
| --- | --- | --- |
| Front model | `gpt-live-1-codex` | `gpt-live-1-boulder-alpha` |
| Voice | `maple` | `cove` |
| Delegation | `{ "type": "client" }` | `{ "type": "client" }` |
| Codex protocol version | `v3` | Not sent through app-server |
| Prompt characters | `12,067` | `1,525` |
| Prompt UTF-8 bytes including newline | `12,164` | `1,526` |
| Prompt SHA-256 | `15cd9c76a427548414c7194b7b1f9f666dc160092aa960ad460715a5ea85347b` | `314fe9eee7018c40cd765644e2d223a4ad31f65991443b14aca3a1c40d83dab5` |
| Startup context | `includeStartupContext: false` | `initial_items` only on continuity |
| Tail flush | `flushTranscriptTailOnSessionEnd: true` | Local tail-flush message |
| Coordinator output mode | `bemTags` | Ordinary streamed Pi text |

One Codex context capture had a 75-character capability appendix:

```text
Codex capabilities available this session:
Apps: Plugin Management, Sites
```

That prompt was 12,142 characters. The core prompt was otherwise identical.

Exact prompt files:

```text
~/Library/Application Support/Pi Voice Research/captures/codex-action-meta-3/evidence/realtime-prompt.md
~/Library/Application Support/Pi Voice Research/captures/pi-action-meta-3/evidence/realtime-prompt.md
```

## What Codex actually tells GPT-Live

The captured prompt is materially more specific than Pi's current policy. Among other rules, it:

- says to decide between answering and `SpawnThinking` before speaking;
- makes current/missing information, inspection, actions, code, files, and substantial artifacts mandatory spawn cases;
- makes plausible screen references such as “this” and “here” mandatory spawn cases;
- defines `[thinking]` as the only event that starts a handoff acknowledgement;
- enters `POST_SPAWN_SILENCE` / `SPAWN_MUTE` after that one acknowledgement;
- suppresses generic “still checking” status;
- distinguishes `[STATUS]`, `[COMPLETE]`, and `::codex-realtime-inline{}` backend content;
- prioritizes new user speech over complete output over status output; and
- explicitly forbids exposing the backend separation.

Pi's prompt says to use the client for substantive work and remain responsive while client work runs. It does not define an in-flight state, one-receipt marker, status/complete channel contract, or special screen-ambiguity rule.

The full prompts, rather than this summary, are the authoritative evidence.

## Recorded coordinator inputs

### Codex

For the first action/meta handoff in `codex-action-meta-2b`, Codex created a dedicated thread with:

| Setting | Value |
| --- | --- |
| Thread source | `realtime_voice` |
| Model | `gpt-5.6-terra` |
| Reasoning | `low`, detailed summary, all-turn context |
| CWD | `/Users/gg/Documents/Codex/2026-07-28/realtime-voice-chat-11` |
| Approval policy | `never` |
| Permissions | `:danger-full-access` |
| Dynamic namespace | `codex_app`, 19 complete schemas |

The first captured logical `response.create` request is 121,766 compact JSON bytes. Its eight input items were:

1. `additional_tools`: `exec`, `wait`, `request_user_input`, and `collaboration`, including the complete 29,874-character `exec` description and freeform grammar.
2. Base Codex developer instructions: 17,730 text characters.
3. Desktop/app developer context: 47,825 text characters.
4. Primary-agent collaboration instructions: 2,185 characters.
5. Multi-agent override: 271 characters.
6. Recommended-plugin context: 1,743 characters.
7. Ponytail instructions active in the captured environment: 5,229 characters.
8. The 203-character `<realtime_delegation>` user item.

The second inference request carried only the incremental custom tool output plus `previous_response_id`; rollout tracing reconstructs its relationship to the first request.

Authoritative files:

```text
~/Library/Application Support/Pi Voice Research/captures/codex-action-meta-2b/evidence/coordinator-thread-start.json
~/Library/Application Support/Pi Voice Research/captures/codex-action-meta-2b/evidence/coordinator-trace/payloads/4.json
~/Library/Application Support/Pi Voice Research/captures/codex-action-meta-2b/evidence/coordinator-trace/payloads/5.json
~/Library/Application Support/Pi Voice Research/captures/codex-action-meta-2b/evidence/coordinator-trace/payloads/12.json
~/Library/Application Support/Pi Voice Research/captures/codex-action-meta-2b/evidence/coordinator-trace/payloads/13.json
```

The normal rollout JSONL contains both response items and UI/event projections. Seeing the delegation XML twice there does not mean it was sent to the provider twice. `payloads/4.json` is the logical request retained by the best-effort trace.

### Pi

The first action/meta provider request used:

| Setting        | Value                                 |
| -------------- | ------------------------------------- |
| Model          | `gpt-5.6-sol`                         |
| Reasoning      | `xhigh`, auto summary                 |
| Text verbosity | `low`                                 |
| Instructions   | 14,098 characters                     |
| Input          | One `<realtime_delegation>` user item |
| Tools          | 7                                     |

The seven tools were `ask_question`, `speak_to_user`, `end_realtime_voice_call`, `exec_command`, `write_stdin`, `apply_patch`, and `view_image`. The next two requests were the normal `exec_command` and `speak_to_user` tool-result continuations, not duplicate realtime handoffs.

Authoritative file:

```text
~/Library/Application Support/Pi Voice Research/captures/pi-action-meta-2/evidence/provider-requests.json
```

## Delegation XML and transcript behavior

For an ordinary observed handoff, both systems sent a user message shaped like:

```xml
<realtime_delegation>
  <input>the current delegated request</input>
  <transcript_delta>mechanical transcript since the prior handoff</transcript_delta>
</realtime_delegation>
```

Codex constructs this in `codex-rs/core/src/context/realtime_delegation.rs`. Pi constructs the same shape in `voice/transcript.ts`.

The shape is conditional: Codex omits `<transcript_delta>` when empty, adds `<source>` for tail flushes, and can derive `<input>` from the transcript delta when the explicit input transcript is empty.

The transcript delta can contain partial and completed copies of the same turn, direct conversation unrelated to the current request, and interleaved user/assistant deltas. This is not unique to Pi. In the controlled Codex food/context run, the coordinator received the food conversation and partial transcripts alongside the context question.

The coordinator must treat `<input>` as the current request and the delta as fallible context. Pi's coordinator addendum now states that explicitly.

## Coordinator output transport

### Codex

Observed frames:

```json
{
  "type": "delegation.context.append",
  "delegation_item_id": "...",
  "channel": "commentary",
  "content": [{ "type": "input_text", "text": "[STATUS] ..." }]
}
```

and:

```json
{
  "type": "delegation.context.append",
  "delegation_item_id": "...",
  "channel": "speakable",
  "content": [{ "type": "input_text", "text": "[COMPLETE] ..." }]
}
```

The coordinator model emits the BEM tags. Codex maps commentary/final output to the explicit channels and keeps it bound to the originating delegation.

### Pi

Observed important spoken update:

```json
{
  "type": "session.context.append",
  "channel": "speakable",
  "content": [{ "type": "input_text", "text": "Git status: ..." }]
}
```

Observed ordinary assistant stream:

```json
{
  "type": "delegation.context.append",
  "delegation_item_id": "...",
  "content": [{ "type": "input_text", "text": "ordinary markdown chunk" }]
}
```

In the observed action runs, Pi gave GPT-Live two representations when the coordinator called `speak_to_user`: the explicit global speakable update and the ordinary assistant stream, with no status/complete metadata on the latter. In two runs, GPT-Live combined its direct answer to the routing meta-question with the late coordinator result.

## Controlled results

### Context routing

| Scenario | Codex | Pi |
| --- | --- | --- |
| Context question alone | 1 handoff; “lemme check what's in front of you” | 0 handoffs; directly said it only knew shared session content |
| Food then context | Food answered directly; context produced 1 handoff | Food answered directly; context produced 0 handoffs |

This is the clearest observed routing difference, consistent across two related but non-repeated scenarios. Codex's mandatory screen-context ambiguity rule covered “working on here”; Pi's policy did not.

### Action followed by routing meta-question

The same 12.681-second stimulus was run three times per implementation.

| Run | Codex handoffs | Codex meta behavior | Pi handoffs | Pi meta behavior |
| --- | --: | --- | --: | --- |
| 1 | 1 | Continued with the Git result | 1 | Said it asked “the execution side” |
| 2 | 1 | Said it “used the orchestrator” | 1 | Said it needed the live repo and combined the result |
| 3 | 2 | Delegated the meta-question, then denied a separate orchestrator | 1 | Directly explained it needed to run Git and combined the result |

Findings:

- Both implementations delegated the actual Git action in all valid runs.
- Pi answered the routing meta-question directly in all three runs. It explicitly exposed an “execution side” in run 1; runs 2 and 3 used unified-assistant wording about needing to inspect or run Git.
- Codex was not deterministic: it exposed “orchestrator” once and delegated the meta-question once.
- Codex's prompt and output protocol improve the intended behavior but do not guarantee it.

One extra Codex attempt, `codex-action-meta-2`, opened WebRTC but received no `session.started` or sideband frames. It is retained as an invalid transport trial and excluded from behavioral counts.

### Silence and low noise

| Input                      | Codex turns/handoffs | Pi turns/handoffs |
| -------------------------- | -------------------: | ----------------: |
| 15 seconds digital silence |                0 / 0 |             0 / 0 |
| 15 seconds low pink noise  |                0 / 0 |             0 / 0 |

Clean silence and low stationary noise did not reproduce the historical false turn. This does not test room transients, speaker feedback, a device driver, or stale server state.

## Historical incident analysis

The persisted Pi session is:

```text
~/.pi/agent/sessions/--Users-gg-code-priv-clanker-extensions--/2026-07-28T14-32-44-518Z_019fa924-6ce6-7f22-af3c-1519827388da.jsonl
```

Relevant original records:

| JSONL line | Timestamp | Event |
| --: | --- | --- |
| 747 | `19:54:47.972Z` | First long research-plan delegation |
| 748 | `19:56:33.404Z` | Pi assistant begins a tool-only turn |
| 752 | `19:56:33.952Z` | Same long delegation inserted again |
| 763 | `20:02:13.178Z` | First “not sure what you're hearing” delegation |
| 767 | `20:24:30.530Z` | Same phrase delegated again |

### What this proves

- The long request reached Pi twice as two separate user messages.
- The `<input>` text is exactly the same in both entries.
- The second arrived 548 milliseconds after Pi began a tool-only turn and while the first task was active, so `sendUserMessage(..., { deliverAs: "steer" })` was the expected Pi behavior.
- The second delegation's transcript had advanced and contained a later “On it.” assistant turn.
- Pi did not manufacture a duplicate merely while rendering the UI; its extension received enough upstream input to call the delegation handler twice.

### What it does not prove

- Whether the two upstream events had the same or different delegation IDs.
- Whether the live model deliberately called the tool again.
- Whether the service retried or replayed an event.
- Whether microphone or speaker audio caused a new user turn.

### Best current explanation

The most plausible explanation is a second GPT-Live handoff decision while the long task was still unresolved:

- the delay was almost 106 seconds, not an immediate duplicate frame;
- the transcript state advanced between handoffs;
- Pi had not delivered meaningful status to the live model during the long interval; and
- Pi's prompt says to remain responsive during client work but lacks Codex's explicit `POST_SPAWN_SILENCE`, `[thinking]`, `[STATUS]`, and `[COMPLETE]` state contract.

This explanation is not promoted to a finding because the original event IDs and sideband frames do not exist.

The repeated “not sure what you're hearing” transcript is a separate signal: the historical delta contains repeated persisted user text and an unsolicited “Mm.” It is a duplication signal, but cannot distinguish repeated speech, accumulated transcription, or duplication elsewhere in the path.

## Artifact index

Capture root, 1.6 GB:

```text
~/Library/Application Support/Pi Voice Research
```

Principal captures:

| Directory                       | Purpose                       |
| ------------------------------- | ----------------------------- |
| `captures/context-4`            | Codex context question        |
| `captures/pi-context-1`         | Pi context question           |
| `captures/codex-food-context-1` | Codex food then context       |
| `captures/pi-food-context-1`    | Pi food then context          |
| `captures/codex-action-meta-1`  | Codex action/meta run 1       |
| `captures/codex-action-meta-2b` | Codex action/meta run 2       |
| `captures/codex-action-meta-3`  | Codex action/meta run 3       |
| `captures/pi-action-meta-1..3`  | Pi action/meta runs           |
| `captures/codex-silence-1`      | Codex silence control         |
| `captures/pi-silence-1`         | Pi silence control            |
| `captures/codex-noise-1`        | Codex noise control           |
| `captures/pi-noise-1`           | Pi noise control              |
| `captures/codex-action-meta-2`  | Invalid Codex transport trial |

Each valid evidence directory contains the applicable subset of:

```text
capture-status.json
realtime-prompt.md
realtime-session-request.json
native-realtime-call-request.json
native-sideband.ndjson
native-sqlite-events.json
app-server-events.ndjson
coordinator-thread-start.json
coordinator-rollout.jsonl
coordinator-trace/
provider-requests.json
pi-events.ndjson
renderer-media-events.ndjson
observed-conversation.json
SHA256SUMS
RAW_SHA256SUMS
```

Raw captures and extracted evidence are private local data. Capture and evidence directories are mode `0700`, and extracted files are mode `0600`. They contain prompts, local paths, session content, tool schemas, and repository output and should not be committed.

## Source references

Pinned public source:

```text
/Users/gg/code/priv/not-mine/codex
commit ff75c5b939c477c49eb1bd5248da6dab71b109d1
```

Important locations:

- `codex-rs/codex-api/src/endpoint/realtime_call.rs:129-204` — call body.
- `codex-rs/http-client/src/transport.rs:88-109` — exact JSON request log.
- `codex-rs/codex-api/src/endpoint/realtime_websocket/methods.rs:462-480` — outgoing sideband text.
- `codex-rs/codex-api/src/endpoint/realtime_websocket/methods.rs:519-525` — incoming sideband text.
- `codex-rs/core/src/realtime_conversation.rs:1453-1558` — handoff routing and transcript selection.
- `codex-rs/core/src/context/realtime_delegation.rs:30-67` — delegation XML.
- `codex-rs/core/src/session/turn.rs:2085-2435` — coordinator response events.
- `codex-rs/core/src/tools/spec_plan.rs:407-492` — generated execution tools.
- `codex-rs/rollout-trace/README.md` and `codex-rs/rollout-trace/src/inference.rs` — best-effort logical trace.

Research tooling:

- `voice/research/codex-runtime-recorder.mjs`
- `voice/research/codex-cli-proxy.mjs`
- `voice/research/extract-codex-capture.mjs`
- `voice/research/pi-runtime-recorder.ts`
- `voice/research/extract-pi-capture.mjs`
- `voice/trace.ts`

## Remaining limits

1. Behavior is sampled, not statistically characterized. Three repetitions are enough to disprove determinism, not estimate stable probabilities.
2. Codex ran in generated projectless voice-task directories while Pi ran in this repository. Routing comparisons are valid; Git-result quality is not an environment-matched comparison.
3. Synthetic audio validates protocol behavior but cannot reproduce physical microphone feedback.
4. The historical extension had no trace enabled. Current source can explain the bridge path but cannot recover old event IDs.
5. The full installed renderer is proprietary bundled code. Public Rust source covers the native protocol and coordinator, while renderer evidence comes from the installed signed runtime.

## Implementation implications

No routing behavior was changed during this research pass.

The evidence supports these next changes, in order:

1. Adopt Codex's in-flight prompt state: one post-handoff receipt, then silence until meaningful status, completion, interruption, or a new user request.
2. Replace Pi's dual unstructured return path with delegation-bound `commentary` and `speakable` status/complete channels.
3. Add Codex's mandatory screen-context and current-state spawn rules.
4. Keep the current Pi session as coordinator, as requested; a dedicated coordinator thread is a Codex product choice, not required by the protocol.
5. Keep raw tracing available for the next physical-microphone reproduction before adding duplicate suppression. Suppression without event IDs risks dropping a legitimate repeated instruction.
