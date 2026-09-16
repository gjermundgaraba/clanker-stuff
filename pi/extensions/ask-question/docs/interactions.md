# Questionnaires

`request_user_input` waits for a reviewed submission. `request_user_input_async` accepts the same questionnaire and returns a durable pending receipt immediately; the agent may continue **independent** work only. A pending receipt is not an answer or approval. Attention notifications belong to the separate experimental `user-attention` extension; this package registers only the two questionnaire tools.

## Requirements

Questionnaires require Pi v0.85.0 APIs, an interactive TUI, and an initialized file-backed session. Both question tools are disabled in RPC, print and JSON modes; stale invocations fail explicitly. `--no-session` is unsupported, including for blocking questions: recoverable drafts and revisable submissions require persistence. Attention messaging has no questionnaire persistence requirement.

## Authoring

Both question tools accept this strict, extension-owned contract:

````json
{
  "title": "Deploy target",
  "context": "## Constraints\nThis is a planning question, not deployment authorization.",
  "questions": [
    {
      "id": "target",
      "header": "Target",
      "question": "Where should this run?",
      "context": "Consider the ongoing maintenance cost.",
      "options": [
        {
          "id": "managed",
          "label": "Managed service",
          "description": "Lower operational burden",
          "preview": "```ts\nconst target = 'managed';\n```"
        },
        { "id": "local", "label": "Local only" }
      ],
      "recommendation": { "option_ids": ["managed"], "reason": "Less maintenance" }
    }
  ]
}
````

- Supply 1–5 required questions, with at most five options each. Omit `options` for written answers. Never supply an `Other` option: the UI provides a separate custom-answer route.
- IDs start with a letter, followed by letters, digits, `_` or `-`, up to 64 characters. Question IDs are unique within the request; option IDs are unique within their question. Labels must be distinct and nonblank.
- `multi_select: true` allows multiple options and a custom response together. Single-select makes custom text an alternative. Blank selected custom answers cannot be submitted.
- Recommendations reference existing option IDs (only one for single-select). They never preselect, reorder or authorize an answer.
- Context and preview fields are Markdown, including language-tagged fenced code. Previews are text, never executable UI or fetched resources. Plain descriptions should be concise.
- Optional `linked_interaction_id` connects a newly authored questionnaire to an existing interaction on this branch. It does not mutate that interaction.

Limits: title/option labels 256 characters, question headers 64, question prompts 1,000, descriptions/recommendation or revision reasons 2,000, each context/preview 12,000. Written answers allow 4,000 UTF-16 code units and each note 1,000; combined serialized answers and the questionnaire note are limited to 40,000 UTF-8 bytes. Editors retain over-limit text for correction rather than silently clipping it.

Schemas reject unknown properties and mixing `questions` with `revise`. Runtime validation remains strict. Pi v0.85.0's constrained-sampling converter cannot represent this structured union: `strict: "prefer"` falls back to ordinary sampling. It is not a promise of provider-constrained generation.

These tools are **not native Codex wire-compatible implementations**. The Codex provider preserves them as external, direct tools, including in Code Mode, independently of native question catalog markers. Its native catalog gate still applies to attention messaging. Ordinary delegated subagents exclude the root-only async questionnaire and attention tools; blocking questionnaires are separate.

## Answering

Use `/answers` to browse this branch's questionnaires: those awaiting you come first, then sent and cancelled ones under a separator. Selecting an item opens its draft immediately, or its latest immutable submission if no draft exists—there is no intermediate action menu. A draft opens on its first unanswered question, or on Review when every question is answered, with the current answer highlighted. In a submitted view, `r` reopens the latest revision for editing, `s` sends an undelivered answer (with an explicit resend warning for uncertain delivery), and Left/Right browse older/newer revisions. Merely viewing a submission never reopens or sends it. Cancelled requests without submissions show their original questions read-only. The compact widget counts only questionnaires that still need you: open drafts and answers never handed to Pi.

The TUI is a full-width single-column surface between two accent rules, at most approximately 60% of terminal height. Its height is fixed for the whole questionnaire at the tallest question, Details or Review view, so nothing jumps while navigating. The title sits in the top rule; a reopened revision names the revision it supersedes there and shows the requested reason under `c` Context. A tab row is always present, even for one question, showing completion; a background marks keyboard focus while `( )`/`(•)` and `[ ]`/`[x]` markers show actual answers. The list itself stays compact: a Details section beneath it shows the highlighted option's description and recommendation rationale, or the written answer. Available context is announced beneath the question, and options with a Markdown preview carry a marker; both name their key. A star marks recommendations without selecting them. Notes and written answers are edited inline beneath their row, with the option list still visible; the questionnaire note is edited beneath the list. Context, previews and review content scroll in the same surface. Resize does not change answers. Very small terminals display a minimum-size instruction.

Inbox rows lead with titles and answer progress or delivery status, not identifiers. Review shows chosen answers and notes, omitting repeated prompts, recommendations and empty sections. Async Review distinguishes **Send answers** (starts or steers a turn) from **Save without sending**. Every key is listed in the footer; `i` opens request metadata, also available in read-only submitted views.

| Action                                   | Default key                                 |
| ---------------------------------------- | ------------------------------------------- |
| Highlight without selecting              | Up/Down or j/k                              |
| Single-select and advance                | 1–5 or selection-confirm (Enter)            |
| Write or edit a written answer           | Selection-confirm on the written-answer row |
| Multi-select toggle                      | 1–5 or Space                                |
| Multi-select advance                     | Selection-confirm, after choosing an answer |
| Previous/next question                   | Left/h/Shift+Tab; Right/l/Tab               |
| Question context / Markdown preview      | c / p                                       |
| Highlighted option or custom-answer note | n                                           |
| Questionnaire-wide note                  | g                                           |
| Review / revision comparison             | r / d                                       |
| Edit a question from Review              | 1–5                                         |
| Submit from Review                       | Selection-confirm                           |
| Submit but keep in inbox (async)         | k                                           |
| Close, retaining draft                   | Selection-cancel (Escape/Ctrl+C)            |
| Cancel request, discarding draft         | x, pressed twice                            |
| Request metadata                         | i                                           |
| Scroll                                   | Configured select PageUp/PageDown           |

Completing the last question opens Review, never automatic submission. `j`/`k` highlight options or scroll detail/read-only views without selecting; on Review, `k` still submits and keeps the answer in the inbox. Editor digits and pasted content are text, not shortcuts. Editors use Pi's configured `tui.input.newLine` (normally Shift+Enter/Ctrl+J) and `tui.input.submit` (normally Enter). Completing an editor saves the field, **never the questionnaire**; saving a nonblank written answer also completes its question and advances, while a blank one deselects itself. Selection-cancel inside an editor discards its unsaved edits and returns to the questionnaire, so over-limit text never traps you. Hints reflect injected bindings; configured selection actions take precedence over the additional letter shortcuts. Closing a blocking questionnaire stops its run and keeps the draft; there is no separate stop key.

Notes stay attached to their option when it is deselected and reselected. Only selected-answer notes and the questionnaire-wide note enter the submitted answer. Unsubmitted drafts never enter model context.

## Delivery and interruption

Async acceptance includes `accepted: true`, `status: "pending"` and `interaction_id`, after a verified disk checkpoint. Answers contain `type: "questionnaire_answer"`, interaction/revision identity, parent revision, provenance, timestamp, answers keyed by question ID with option IDs and label snapshots, custom text and notes. Revisions list changed questions. A live blocking waiter receives that answer as its tool result, not an extra user message. Async/recovered answers use a correlated textual user message with `deliverAs: "steer"`; sending while idle starts a turn, as the UI states.

The transcript displays an exact, known answer message as a readable summary with its revision, selected answers, written text and all submitted notes; user text is escaped so it never becomes Markdown structure. Sending or keeping answers is confirmed with a short notification. This is a display-only Markdown transformation: the complete structured envelope remains unchanged in model context and session history, including after reload. Use `/answers` to inspect submissions. Edited, quoted, combined queue text and messages not found on the current branch stay verbatim rather than hiding potentially unrelated user content. Pi's restored queue editor also retains the original text.

A submission is immutable and separate from delivery. Status can be pending, handed to Pi, delivered, or uncertain. Delivered means present in canonical parent history, not that the model has acted on it. Explicit Send or Submit-and-continue resumes only the selected request. Reopening the UI or ordinary subsequent prompts never resume delivery automatically.

Pi exposes run abortion, not a distinct user-Stop reason. Every observed run abort conservatively pauses coordinator-owned delivery, including pending requests created in earlier runs. Closing async UI does not abort the parent; closing or cancelling a blocking questionnaire aborts its requesting run. Cancellation is not an answer.

**Once queued, Pi owns the message.** Built-in TUI Stop and `ctx.abort()` clear Pi's queues and restore queued text to its editor; the extension cannot selectively retract its answer or clear unrelated queues. Check history and restored editor text before explicitly resending a handed-off/uncertain submission. No automatic outbox replay or exactly-once guarantee is offered.

## Persistence and recovery

Authored requests, draft checkpoints, immutable submissions and delivery bookkeeping live in Pi custom session entries, not another database. Writes participate in Pi's per-file mutation queue and are verified against the session file. Partial/unreadable or inconsistent files fail closed. Durability follows Pi's successful file writes, not an extra fsync/power-loss guarantee.

Editor text is checkpointed when a field is saved and flushed on orderly close, Stop, reload and navigation. A hard crash can lose the text of an editor that is still open. Disk failures are reported rather than converted into acceptance; correct the storage problem and reopen a verified session before continuing.

Replay reads only the active branch and restores interactions paused. Session changes invalidate old views and callbacks. Forks inherit recorded state with independent ownership. Recovery reconciles both matching canonical user messages and successful blocking tool results using tool-call provenance and the exact answer identity. A persisted blocking answer is not redelivered just because its old JavaScript waiter is gone. Ambiguous handoffs require an explicit recovery decision.

Historical transcripts are not rewritten. The retired `ask_question` name is not registered. Only the surviving async name's old persisted `title`/string-option calls have argument preparation; those fields are absent from the public schema. Old ephemeral pending maps cannot be recovered.

## Revisions

Users can Reopen the latest submitted revision from `/answers`. Either tool can request the same operation:

```json
{
  "revise": {
    "interaction_id": "q_example",
    "base_revision": 1,
    "reason": "Reconsider after the new constraint"
  }
}
```

The original questions and previews remain unchanged; the new draft starts from the latest submission. Only one draft can exist. Stale base revisions, conflicting edits and repeated Submit are rejected, never overwritten. Bookkeeping-only pause/delivery changes can be rebased without changing the user's draft. The comparison view shows before/after values only for changed answers and notes; submission creates revision 2, explicitly superseding revision 1 without deleting it.

Changing an answer cannot undo actions already performed. The agent must reconsider affected work rather than treating a revision as retroactive permission.

## Inbox indicator

With the experimental border-status host loaded, the editor's top border shows a mail icon and the number of questionnaires requiring attention. Drafts (including paused drafts) and pending/uncertain deliveries count; sent or cancelled items do not. Opening the inbox does not clear the indicator. The icon follows the host's Unicode, ASCII, or Nerd Font preference. Press Alt+I or use `/answers` to open the inbox.

The above-editor questionnaire widget remains visible while attention is required, independently of the border host. The border count is supplementary: both can appear at once. Narrow terminals, competing border statuses, or replacement editors may hide the border count without hiding the widget.
