# Questionnaires

`request_user_input` waits for a reviewed submission. `request_user_input_async` accepts the same questionnaire and returns a pending receipt immediately; the agent may continue **independent** work only. A pending receipt is not an answer or approval. Attention notifications belong to the separate experimental `user-attention` extension; this package registers only the two questionnaire tools and `revise_user_input`.

## Requirements

Questionnaires require the interactive TUI. In RPC, print and JSON modes the three tools are withdrawn (`exposure: "hidden"`), so neither `--tools` nor another extension can activate them, and `/answers` reports the channel as unavailable. Any session works, including `--no-session`; without a session file, questionnaires last as long as the process.

## Authoring

Both question tools accept this closed, extension-owned contract:

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

Tool schemas are structural: closed objects, types and required fields, which Pi's strict constrained-sampling converter can represent. All three tools request `strict: "prefer"`, so providers without strict tool support fall back to ordinary sampling. Lengths, counts, ID syntax and uniqueness are runtime validation, reported as tool errors.

These tools are **not native Codex wire-compatible implementations**. Native Pi owns their serialization and Code Mode placement; there is no provider-specific catalog gate. Ordinary delegated subagents exclude the root-only async questionnaire and attention tools; blocking questionnaires are separate.

## Answering

Use `/answers` to browse this branch's questionnaires: those awaiting you come first, then sent and cancelled ones under a separator. Selecting an item opens its draft immediately, or its latest immutable submission if no draft exists—there is no intermediate action menu. A draft opens on its first unanswered question, or on Review when every question is answered, with the current answer highlighted. In a submitted view, `r` reopens the latest revision for editing, `s` sends the answer (**Send again** once it was sent), and Left/Right browse older/newer revisions. Merely viewing a submission never reopens or sends it. Cancelled requests without submissions show their original questions read-only. The compact widget counts only questionnaires that still need you: open drafts and answers not yet sent.

The TUI is a full-width single-column surface between two accent rules. It sizes naturally toward approximately 60% of terminal height; auxiliary pages scroll within that cap, while question views may expand only as far as needed to keep compact answer controls visible. The title sits in the top rule; a reopened revision names the revision it supersedes there and shows the requested reason above each question. A tab row is always present, even for one question, showing completion; a background marks keyboard focus while `( )`/`(•)` and `[ ]`/`[x]` markers show actual answers.

Available Markdown context appears automatically in a dedicated viewport above the compact, pinned question and answer rows: revision reason, questionnaire-level context, then the current question’s context. PageUp/PageDown scroll only that viewport, so answer controls remain visible. Options with a description, recommendation rationale or Markdown preview carry a `p` details marker; `p` opens all of that option’s auxiliary content in one scrollable page. A star marks recommendations without selecting them. Written answers and notes use a focused editor page, then return to the answer list on save or discard. Saved notes and written answers appear as compact one-line excerpts. Resize does not change answers. Terminals unable to fit even the compact question and answer controls display a minimum-size instruction.

Pi fullscreen mode routes mouse-wheel events over the context or auxiliary viewport. Regular mode retains native terminal selection and scrollback, so questionnaire scrolling there is keyboard-only.

Inbox rows lead with titles and answer progress or delivery status, not identifiers. Review shows chosen answers and notes, omitting repeated prompts, recommendations and empty sections. Async Review distinguishes **Send answers** (starts or steers a turn) from **Save without sending**. Every key is listed in the footer; `i` opens request metadata, also available in read-only submitted views.

| Action                                   | Default key                                 |
| ---------------------------------------- | ------------------------------------------- |
| Highlight without selecting              | Up/Down or j/k                              |
| Single-select and advance                | 1–5 or selection-confirm (Enter)            |
| Write or edit a written answer           | Selection-confirm on the written-answer row |
| Multi-select toggle                      | 1–5 or Space                                |
| Multi-select advance                     | Selection-confirm, after choosing an answer |
| Previous/next question                   | Left/h/Shift+Tab; Right/l/Tab               |
| Highlighted option details               | p                                           |
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

## Delivery

Async acceptance includes `accepted: true`, `status: "pending"` and `interaction_id`, after the request is recorded in the session. Answers contain `type: "questionnaire_answer"`, interaction identity, title, revision, provenance, timestamp, answers keyed by question ID with option IDs and label snapshots, custom text and notes. Revisions list changed questions. A live blocking waiter receives that answer as its tool result, not an extra user message. Other answers are sent as a textual user message with `deliverAs: "steer"`; sending while idle starts a turn, as the UI states.

The transcript displays an exact answer message as a readable summary with its revision, selected answers, written text and all submitted notes; user text is escaped so it never becomes Markdown structure. The summary is rebuilt from the message's own envelope, so it reads the same on any branch and after reload. Sending or keeping answers is confirmed with a short notification. This is a display-only Markdown transformation: the complete structured envelope remains unchanged in model context and session history. Edited, quoted or combined text is not an exact answer message and stays verbatim.

A submission is immutable; it records when it was sent. Nothing is ever sent automatically: only Submit in a blocking questionnaire, or an explicit Send, delivers an answer. Background work, wakes, reopening the UI and ordinary prompts never do. A blocking answer is recorded as sent before its tool result returns. Closing or cancelling a blocking questionnaire aborts its requesting run; stopping that run keeps the draft. Cancellation is not an answer.

**Once sent, Pi owns the message.** Built-in TUI Stop and `ctx.abort()` clear Pi's queues and restore queued text to the editor, including a queued answer; the inbox still shows it as sent. Check the restored editor text before using **Send again**: a second send is a second user message. If Pi rejects the message instead, for example because no model or credentials are set up, Pi shows the error and the questionnaire still reads as sent; use **Send again** once fixed.

## Persistence

Authored requests are recorded once as `questionnaire.request` custom session entries; drafts, submissions and send times follow as `questionnaire.state` entries. Pi writes them synchronously, so a failed write fails the action that caused it. Editor text is recorded when a field is saved and flushed on close, Stop, reload and navigation; text that cannot be saved, such as over-limit text, is reported and dropped. Pi's navigation commands cannot start while a questionnaire has focus. A hard crash can lose the text of an editor that is still open.

Replay reads only the active branch; the last state of each request wins. Unreadable entries are skipped rather than blocking the session. Branch changes close views opened on the previous branch. Forks inherit recorded state.

Historical transcripts are not rewritten and render as written. Pi never re-executes stored tool calls, so retired names and argument shapes have no argument preparation.

## Revisions

Users can Reopen the latest submitted revision from `/answers`. `revise_user_input` requests the same operation:

```json
{
  "interaction_id": "q_example",
  "base_revision": 1,
  "reason": "Reconsider after the new constraint"
}
```

It waits for the revised answer or returns a pending receipt the same way the questionnaire was last asked.

The original questions and previews remain unchanged; the new draft starts from the latest submission. Only one draft can exist. Stale base revisions and repeated Submit are rejected, never overwritten. The comparison view shows before/after values only for changed answers and notes; submission creates revision 2, explicitly superseding revision 1 without deleting it.

Changing an answer cannot undo actions already performed. The agent must reconsider affected work rather than treating a revision as retroactive permission.

## Inbox indicator

While questionnaires need you, a widget above the editor counts them, and the footer status `ask-question` shows a mail icon with the same count. Drafts and unsent answers count; sent or cancelled questionnaires do not. Opening the inbox does not clear the indicator. Press Alt+I or use `/answers` to open the inbox.
