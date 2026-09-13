# User interactions

`ask_question` pauses tool execution until the user submits answers. Its existing strict schema, notes, multiple selection, and cancellation behavior remain intact. Canceling this blocking tool aborts the current run.

`request_user_input_async` accepts `{ questions: [{ title, options? }] }` and immediately returns `{"accepted":true}`. Each title is a complete question. Options are suggestions; omit them for free text. The UI supplies Other. The first suggested option is selected initially, but no answer is submitted until the user explicitly submits the questionnaire.

Pending questions appear above the editor. Run `/answers` to select a pending request, answer its questions, or dismiss it with Escape. Work can continue while questions are pending and while their UI is open. Submitting delivers ordinary user input: it steers a busy agent or starts a new turn when idle. Dismissal sends no answer and does not abort the run.

`send_message_to_user_async` accepts `{ message }`, displays an attention message in the transcript, and immediately returns `{"accepted":true}`. Use it for a blocker, a decision, or a response to a status request during ongoing work; routine progress belongs in commentary. The user replies through normal input.

Pending UI is ephemeral and belongs to its originating session and branch. Cancellation, session replacement, successful fork, branch navigation, reload, and shutdown remove it. Completed answers remain in normal session history. Restoring history does not reopen old requests.

The question tools require the interactive terminal UI. The shared prompt queue coordinates blocking questions, the answers UI, and MCP input dialogs. Pending async questions emit no blocked status; the timer continues counting agent work during async input.

Both async tools are root-only in managed subagent sessions. With the Codex provider they remain direct model tools even in Code Mode and follow the model catalog's supported-tool declarations. The historical catalog marker `send_user_message_async` enables `request_user_input_async`; it is not a second public tool. Attention messages require `send_message_to_user_async` support. Other providers expose the installed tools normally.

The schemas and descriptions follow the [audited Codex handlers](https://github.com/openai/codex/tree/36f0dbe796d9bb1a18a0fc0640ed08b3e1d54564/codex-rs/core/src/tools/handlers). Pi uses a pending widget and `/answers` because it does not expose Codex's native async message UI.
