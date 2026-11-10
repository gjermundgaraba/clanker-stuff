# Questionnaires

`request_user_input` asks the user up to five structured questions. With `wait: true` the call waits for a reviewed submission. With `wait: false` it returns a pending receipt immediately and the agent may continue **independent** work only; a pending receipt is not an answer or approval.

## Requirements

Questionnaires require the interactive TUI. In RPC, print and JSON modes the tool is withdrawn (`exposure: "hidden"`), so neither `--tools` nor another extension can activate it, and `/answers` reports the channel as unavailable. Delegated subagents run in print mode, so the tool is not available there. Any interactive TUI session works, including `--no-session`; without a session file, questionnaires last as long as the process.

## Authoring

The tool accepts this closed, extension-owned contract:

````json
{
  "wait": true,
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
      "recommendation": {
        "option_ids": ["managed"],
        "reason": "Less maintenance"
      }
    }
  ]
}
````

- `wait` is required. Use `false` only when independent work can continue without the answers.
- Supply 1–5 required questions, with at most five options each. Omit `options` for written answers. Never supply an `Other` option: the UI provides a separate custom-answer route.
- IDs start with a letter, followed by letters, digits, `_` or `-`, up to 64 characters. Question IDs are unique within the request; option IDs are unique within their question. Labels must be distinct and nonblank.
- `multi_select: true` allows multiple options and a custom response together. Single-select makes custom text an alternative. Blank selected custom answers cannot be submitted.
- Recommendations reference existing option IDs (only one for single-select). They never preselect, reorder or authorize an answer.
- Context and preview fields are Markdown, including language-tagged fenced code. Previews are text, never executable UI or fetched resources. Plain descriptions should be concise.

Limits: title/option labels 256 characters, question headers 64, question prompts 1,000, descriptions and recommendation reasons 2,000, each context/preview 12,000. Written answers allow 4,000 UTF-16 code units and each note 1,000; combined serialized answers are limited to 40,000 UTF-8 bytes. Editors retain over-limit text for correction rather than silently clipping it.

The tool schema is structural: closed objects, types and required fields, which Pi's strict constrained-sampling converter can represent. The tool requests `strict: "prefer"`, so providers without strict tool support fall back to ordinary sampling. Lengths, counts, ID syntax and uniqueness are runtime validation, reported as tool errors.

This tool is **not a native Codex wire-compatible implementation**. Native Pi owns its serialization and Code Mode placement; there is no provider-specific catalog gate.

## Answering

A waiting questionnaire opens at once. Use `/answers` or Alt+I to list the questionnaires still open on this branch; choosing one opens its draft on its first unanswered question, or on Review when every question is answered, with the current answer highlighted.

The TUI is a full-width single-column surface between two accent rules. It sizes naturally toward approximately 60% of terminal height; auxiliary pages scroll within that cap, while question views may expand only as far as needed to keep compact answer controls visible. The title sits in the top rule. A tab row is always present, even for one question, showing completion; a background marks keyboard focus while `( )`/`(•)` and `[ ]`/`[x]` markers show actual answers.

Available Markdown context appears automatically in a dedicated viewport above the compact, pinned question and answer rows: questionnaire-level context, then the current question’s context. PageUp/PageDown scroll only that viewport, so answer controls remain visible. Options with a description, recommendation rationale or Markdown preview carry a `p` details marker; `p` opens all of that option’s auxiliary content in one scrollable page. A star marks recommendations without selecting them. Written answers and notes use a focused editor page, then return to the answer list on save or discard. Saved notes and written answers appear as compact one-line excerpts. Resize does not change answers. Terminals unable to fit even the compact question and answer controls display a minimum-size instruction.

Pi fullscreen mode routes mouse-wheel events over the context or auxiliary viewport. Regular mode retains native terminal selection and scrollback, so questionnaire scrolling there is keyboard-only.

Review shows chosen answers and notes, omitting repeated prompts, recommendations and empty sections. For a questionnaire nobody is waiting on, Review names the submit action **Send answers** and notes that it starts or steers a turn. Every key is listed in the footer.

| Action | Default key |
| --- | --- |
| Highlight without selecting | Up/Down or j/k |
| Single-select and advance | 1–5 or selection-confirm (Enter) |
| Write or edit a written answer | Selection-confirm on the written-answer row |
| Multi-select toggle | 1–5 or Space |
| Multi-select advance | Selection-confirm, after choosing an answer |
| Previous/next question | Left/h/Shift+Tab; Right/l/Tab |
| Highlighted option details | p |
| Highlighted option or written-answer note | n |
| Review | r |
| Edit a question from Review | 1–5 |
| Submit from Review | Selection-confirm |
| Close, retaining draft | Selection-cancel (Escape/Ctrl+C) |
| Dismiss without answering | d |
| Scroll | Configured select PageUp/PageDown |

Completing the last question opens Review, never automatic submission. `j`/`k` highlight options or scroll detail views without selecting. Editor digits and pasted content are text, not shortcuts. Editors use Pi's configured `tui.input.newLine` (normally Shift+Enter/Ctrl+J) and `tui.input.submit` (normally Enter). Completing an editor saves the field, **never the questionnaire**; saving a nonblank written answer also completes its question and advances, while a blank one deselects itself. Selection-cancel inside an editor discards its unsaved edits and returns to the questionnaire, so over-limit text never traps you. Hints reflect injected bindings; configured selection actions take precedence over the additional letter shortcuts.

Notes stay attached to their option when it is deselected and reselected. Only selected-answer notes enter the submitted answer. Unsubmitted drafts never enter model context.

## Delivery

Every result and message carries one object: `type: "questionnaire"`, `interaction_id`, `title` and `status`, plus `answers` keyed by question ID, with option IDs and label snapshots, custom text and notes, when `status` is `answered`. The model reads it as JSON text; the transcript renders the same object as a readable summary, escaping user text.

- A pending receipt has `status: "pending"`.
- A waiting call returns the submission as its tool result, not as an extra message.
- Dismissing a waiting questionnaire returns `status: "dismissed"` and the run continues.
- Closing a waiting questionnaire, or stopping its run, returns `status: "closed"` and stops the run. The draft stays open in `/answers`.
- Answering a questionnaire nobody is waiting on sends the answers as an `ask-question` custom message with `deliverAs: "steer"`: it steers the current run or, while idle, starts a turn.
- Dismissing one sends a `dismissed` message the same way, except that while idle it is recorded for the agent's next turn instead of starting one.

Submitting sends at once; nothing is sent automatically. Background work, wakes, reopening the UI and ordinary prompts never do.

Pi's Stop clears the messages queued for the run it stops. When a run that received answers ends aborted and those answers never reached the session, the questionnaire reopens with the submitted draft and a warning; use `/answers` to send it again.

## Persistence

Authored requests are recorded once as `ask-question.request` custom session entries; each draft change follows as an `ask-question.state` entry. A state without a draft closes the questionnaire; the tool result or message that carries the outcome records whether it was answered or dismissed. Pi writes these entries synchronously, so a failed write fails the action that caused it. Editor text is recorded when a field is saved and flushed on close, Stop, reload and navigation; text that cannot be saved, such as over-limit text, is reported and dropped. Pi's navigation commands cannot start while a questionnaire has focus. A hard crash can lose the text of an editor that is still open.

Replay reads only the active branch; the last state of each request wins and only open questionnaires are kept, listed most recently changed first as they were before the reload. Fields that earlier versions recorded, such as `updated_at`, are ignored, and unreadable entries are skipped rather than blocking the session. Branch changes close views opened on the previous branch. Forks inherit recorded state.

Historical transcripts are not rewritten and render as written. Pi never re-executes stored tool calls, so retired names and argument shapes have no argument preparation.

## Inbox indicator

While questionnaires are open, a widget above the editor counts them, and the footer status `ask-question` shows a mail icon with the same count. Opening the inbox does not clear the indicator; answering or dismissing does. Press Alt+I or use `/answers` to open the inbox.

Terminals that read Pi's program status (OSC 7501), such as Herdr, see Pi as blocked on a question while a waiting questionnaire is open. Pi restores the appropriate run status when it closes.
