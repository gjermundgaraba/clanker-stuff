# Natural-prompt acceptance testing

This is a maintainer checklist for live model behavior and terminal UX, not an automated unit test or a model comparison. Use fresh synthetic scenarios; never commit session transcripts or copy private history into fixtures. Contract and lifecycle rules are in [interactions.md](interactions.md).

## Setup and evidence

From the repository root, load source without installing the package:

```sh
pi --no-extensions --no-skills --no-prompt-templates --no-context-files \
  -e "$PWD/pi/extensions/ask-question/index.ts" \
  -e "$PWD/pi/extensions/experimental/codex-provider/index.ts"
```

Keep persistence enabled. Record the Pi version, provider/model, reasoning level, Code Mode state, loaded extensions, repository revision and working-tree state. When driving through Herdr, follow its skill: verify `HERDR_ENV=1`, discover CLI syntax, target an explicitly identified test pane, and preserve focus. Native Pi arguments follow `herdr agent start … --`.

Start a fresh session for each numbered scenario below. `/new` is sufficient; continuing an earlier session with argument examples is not a first-use test. Give the agent the task prompt only—not the expected behavior, tool names, argument templates, field names, IDs, or source files. Ask it not to inspect files, run commands or implement anything. Registered tool descriptions and schemas remain available normally.

Observe the actual tool calls and results in the test session, not only the agent's claims or Herdr's idle/blocked indicator. Record session references, call counts, validation errors/retries, chosen answers and behavior after submission. Verify the canonical session separately from its display-only rendering. Inspect only the known test session; keep raw evidence outside the repository.

## Scenarios

### 1. Blocking clarification, rich options and answer fidelity

Task prompt:

> Help me design a personal photo organizer. Use the question tool to ask how I want to store metadata and which capabilities belong in the first release; I may choose several. Recommend an approach with tradeoffs and let me compare concrete example metadata files before choosing. Wait for my answers before proposing a design.

Tester checks:

- The agent chooses a blocking questionnaire with valid IDs, genuine multi-select, structured recommendations and dedicated Markdown previews; no authored Other option or preselection.
- Open a preview and context without choosing. Select against a recommendation, attach an option note, and add a questionnaire-wide constraint. Complete Review explicitly.
- The resulting plan follows selections and both notes, rather than substituting recommended answers or treating notes as execution permission.

Follow-up prompt after completion:

> I want to reconsider the metadata choice. Reopen the same questionnaire, keeping its questions, other choices and notes. After I submit, explain only what changes in the design.

- The agent obtains the interaction identity and latest revision from its own context and uses a revision request, not a duplicate form.
- Revise a choice. Verify preserved answers, the superseding revision and a focused reconsideration of affected work.

### 2. Async boundaries, written answers and linked follow-ups

Task prompt:

> Help me plan an internal metrics dashboard. Use the question tool to ask about hosting and let me describe data-handling constraints in my own words. I will answer later. Meanwhile, prepare a short hosting-independent accessibility checklist. Do not choose hosting or assume the constraints before my answers arrive.

Tester checks:

- The agent chooses async without being told its name. The pending receipt is not an answer; it completes only independent work.
- Open `/answers`, choose hosting, and enter multiline constraints that include an unresolved requirement and explicitly withhold deployment approval.
- Submit but keep in the inbox first: no answer reaches the model. Then explicitly Send; confirm that the UI warns this can start a turn.
- The displayed answer contains selections and notes without a JSON dump. Canonical history and model context still contain the original envelope. Reload and inspect the same message again.
- The agent incorporates the written constraints without inventing approval or treating pending legal/operational questions as settled.

Follow-up prompt:

> Now ask different questions: which monitoring services to shortlist, allowing several, and my budget in my own words. Keep this connected to the earlier questionnaire without replacing those answers. I can answer now; wait before refining the plan.

- The agent authors a new linked request, rather than changing the original questions through a revision.

### 3. Questionnaire limits and complete collection

Task prompt:

> Help me plan an internal document archive. Use the question tool to collect six separate decisions: source files, indexing schedule, search interface, access controls, retention period and rollout strategy. Keep each decision separate, recommend practical defaults, and wait for all six before designing the system.

- The agent respects the five-question limit without collapsing separate decisions or sending invalid arguments. Multiple batches are valid; exact batch sizes are not prescribed.
- Answer each batch. The agent collects every decision before producing a design, preserves provenance between related forms, and follows the submitted answers.

## Input and rendering regressions

Use any naturally authored form above. These are operator actions, not instructions to the model.

- Open an option note, type text, then rapidly press editor-submit followed by an option number. The number must select an option, not leak into the saved note. Repeat while persistence is delayed in the unit harness.
- Write an answer and press editor-submit: the question completes and the form advances. Reopen the row, edit, then press selection-cancel: the edit is discarded and the saved answer remains.
- Rapidly open an editor and type or paste: initial characters must not disappear. Numbers and shortcut letters inside a paste stay text.
- Try multiline input, default and remapped completion bindings, over-limit text, and Stop with an open editor. Over-limit text cannot be saved but can always be discarded with selection-cancel; completing a field never submits the questionnaire. Press `x` once (a hint asks for confirmation), then any other key: nothing is cancelled.
- Test both separate Herdr key events without artificial pacing and a batched key command. Use bracketed paste for text. Compare with physical typing when available; do not claim physical-keyboard verification from injected input alone.
- Verify the tab row (also for a single question), distinct focused/selected markers, the Details section for the highlighted option, recommendation rationale and note excerpts. Open a note with `n`: the editor must appear beneath the option with the list still visible. Move between questions with `h`/`l` and into Review: the frame height must not change. Resize with a lower option focused; navigating must reveal its label without moving the pinned controls. Check that long labels, Unicode and remapped keys stay within the frame.
- Open the inbox: questionnaires awaiting you are listed first, sent and cancelled ones below a separator; titles/progress should be readable without IDs; Enter opens directly. Review should omit empty notes and repeated recommendations. Reopen a submission: it opens on Review with the superseded revision in its title; change one answer and inspect Changes: unchanged questions should not repeat. Request IDs and submission provenance remain available through Details.
- Inspect the screen after each tested transition. Pacing can help operate a form, but must not be used to conceal an ordering failure.
- For async messages, check selected-option notes, custom-answer notes, long multiline text and revisions. Nothing is silently truncated or interpreted as transcript markup, and no code fences or backslashes appear around the summary. Edited messages and answers restored alongside unrelated queued text remain verbatim.
- Verify Stop/reload does not auto-resend and that rendering alone never changes delivery status. Existing lifecycle tests cover queue ownership and recovery boundaries; repeat those journeys when changing delivery code.

## If the agent gets it wrong

Before supplying corrections or an argument example, ask neutral follow-ups:

1. “What led you to that tool choice or call? What did you understand the available instructions to require?”
2. “Was any relevant capability missing, unclear, or in conflict with another instruction?”
3. “Given the observed result, can you retry using the available tool instructions?”

Record the initial call, error/result, explanation and retry separately. The explanation is a self-report, not proof of causation. Distinguish model misuse from schema rejection, extension faults and test-driver input problems. A coached recovery does not turn the original attempt into a pass.

Report passes, failures and unverified checks explicitly. A successful small sample supports discoverability; it does not establish a cross-model reliability rate.
