# Equivalent-code consolidation

Branch: `refactor/consolidate-equivalent-code`. Base: `bb74648`. No push or merge.

Merged **13 groups**, saving **77 lines net** across code, tests, package metadata, lockfile, and deployment copies. This report is excluded from that count. Negative savings below mean that imports, explicit dependencies, or standalone deployment copies cost more lines than the removed bodies; those changes still establish one implementation to maintain. Counts use Git's added/deleted lines, including comments and whitespace.

## Merged groups

Each group was tested before its commit. Every applicable former implementation now calls or imports the shared implementation directly.

| # | Group and retained implementation | Why this version; callers updated | Net lines saved | Tests after the group |
| --- | --- | --- | --: | --- |
| 1 | Diagram text helpers in [digest_text.py](../skills/diagram-design/scripts/digest_text.py); UTF-8 setup now in [digest_cli.py](../skills/diagram-design/scripts/digest_cli.py) | Retained draw.io's identical escaping, line folding, and stdout setup. Updated draw.io, Excalidraw, and the matching Mermaid helpers. | 29 | 33 diagram tests; 16 digest comparisons |
| 2 | Canvas report sections in [canvas_digest.py](../skills/diagram-design/scripts/canvas_digest.py) | Retained draw.io's summary, graph findings, and node/edge tables, which Excalidraw rendered identically. Both extractors supply their existing analysis and geometry. | 36 | 33 diagram tests; 16 digest comparisons |
| 3 | Questionnaire `oneLine` in [summary.ts](../pi/extensions/ask-question/summary.ts) | Moved the unchanged transcript implementation; transcript and TUI both require display sanitization followed by whitespace collapse. | 1 | 72 questionnaire tests |
| 4 | `fit` and `renderScrollbar` in [layout.ts](../pi/packages/tool-rendering/layout.ts) | Retained context's width fitting and scrollbar calculation. Its explicit nonpositive-height guard matches the other version's empty result. Context and subagents use the shared exports. | 18 | 311 tool-rendering, context, and subagents tests |
| 5 | `errorMessage` in [text.ts](../pi/packages/tool-rendering/text.ts) | Retained footer's exact `Error.message`/`String(value)` conversion. Replaced matching MCP, editor, extension, and harness helpers/expressions; surrounding sanitization stays at each caller. | -23 | Full suite: 1,476 passed, 10 skipped |
| 6 | `createIdentityEditorTheme` in [tui.ts](../pi/tests/harness/tui.ts) | Retained the identical identity theme as a factory, preserving a fresh object per caller. Updated editor, footer, history, and dollah-skills fixtures. | 34 | 147 tests in those packages |
| 7 | Extension-host action methods in [extension-host.ts](../pi/tests/harness/extension-host.ts) | Test controls now reference the existing action methods for active tools and thinking level; they already close over the same state and do not use `this`. | 8 | 37 harness tests |
| 8 | Claude message factories in [messages.ts](../pi/extensions/experimental/claude-bridge/tests/session/messages.ts) and [sdk.ts](../pi/extensions/experimental/claude-bridge/tests/fixtures/sdk.ts) | Reused the existing zero-timestamp user/text factories and provider's read-tool message. Updated turn, conversation, and provider tests without changing assertions. | 26 | 241 Claude bridge tests passed, 9 skipped |
| 9 | Evaluation `isRecord` in [records.mjs](../pi/evals/verifiers/records.mjs) | Retained the non-null, non-array object check shared by compaction, tool-mode, native Codex, scaling, and smoke validators. Exporters include the shared module and relocate scaling imports for flattened task bundles. | -15 | 100 evaluation tests passed, 1 skipped; 14 compaction and 32 LongMemEval tests passed |
| 10 | Evaluation `trajectoryRecords` in [records.mjs](../pi/evals/verifiers/records.mjs) | Retained compaction's agent/extra decoding, including property access order. Compaction, tool-mode, scaling grading, and scaling validity share it; validity also consumes the decoded agent. | -25 | Same evaluation suites: 146 passed, 1 skipped |
| 11 | Claude `sessionContents` in [session.ts](../pi/extensions/experimental/claude-bridge/tests/fixtures/session.ts) | Retained provider's session reader; provider and rebuild tests pass their own working directories explicitly. | 3 | 241 Claude bridge tests passed, 9 skipped |
| 12 | Compaction `readTrajectory` and `probe` in [compaction.mjs](../pi/evals/verifiers/compaction.mjs) | Retained the existing read/parse fallback and exception-to-zero scoring. All three compaction graders pass their trajectory path and keep their task-specific assertions. | -26 | Evaluation suites: 146 passed, 1 skipped |
| 13 | Diagram output options and writing in [digest_cli.py](../skills/diagram-design/scripts/digest_cli.py) | Retained draw.io's identical option definitions and output writer; all three extractors pass their own error handler. UTF-8 setup moved here from group 1. | 11 | 33 diagram tests; 24 complete CLI comparisons |

## Similar code kept separate

| Location | Difference that prevents merging the whole implementation |
| --- | --- |
| Diagram extractors: escaping | Mermaid's table escaping replaces literal LF; draw.io and Excalidraw use `splitlines()`, which handles other separators and trailing newlines differently. |
| Diagram extractors: geometry and analysis | Excalidraw checks aspect-ratio overflow, excludes frames from some analysis, and handles group membership differently. Draw.io has shape families, page selection, and different inference and sorting rules. |
| Diagram extractors: CLI validation | Draw.io calls `parser.error` for invalid `--max-rows`; the others use format-specific `_fail`. Page/diagram selection and input limits also differ. Shared output handling preserves those distinctions. |
| Pi error formatters | Claude bridge extracts message/error fields from plain objects and uses Node formatting. Usage HTTP/cache paths have different fallback text; history sometimes omits non-Error details. Outer sanitization and truncation policies also differ. |
| Usage and MCP request wrappers | Generic usage makes one request and treats HTTP 403 as unavailable. xAI makes two concurrent requests and tolerates an optional failure. MCP calls have different pagination and client lifetimes. |
| Context and subagent overlays | Minimum sizes, pane ratios, selection, trees, and live transcript lifecycles differ. Only width fitting and scrollbar rendering were equivalent. |
| Questionnaire and subagent abort waits | Questionnaire waiting also orders queue release and requires a signal; subagent waiting accepts an optional signal. The short abort callbacks close over different promises. |
| Claude bridge state invocations | Streaming and delivery both subscribe to aborts, but belong to different typed states and lifetimes; delivery also invokes steering. The repeated declarations remain local to their states. |
| Resume-history hooks | Claude uses `claude --resume`; Codex uses `codex resume`. Validation and cleanup after a failed move differ. Each plugin must install independently. |
| Evaluation JSONL readers | The general reader rejects whitespace-only records and reports path/line errors; frontier state skips stripped whitespace and records partial/error status. |
| Pi and Codex evaluation adapters | Option parsing has different superclass contracts and supported options; execution and compaction protocols differ. Matching method shapes do not imply identical behavior. |
| Claude and completion test fixtures | Some factories advance independent clocks; others use timestamp zero. Assistant fields and image defaults differ. Completion helpers close over separate registered completers. |
| Task renderers and CLI entrypoints | Working indicators sit inside different state, heading, and result rendering. Entrypoint guards dispatch different commands. Sharing small fragments would not consolidate equivalent components. |
| Evaluation task templates | LongMemEval and Mem2Act repeat resource settings but generate different tasks and grader contracts. Task-specific grading assertions and candidate-loading errors remain independent. |

## Intentional copies and audit limits

- Compaction and smoke grader bundles must run without the repository. They carry copies of canonical verifier modules; compaction tests check byte equality and execute the isolated graders. Scaling, frontier, and LongMemEval exporters include the new dependency. Source-freezing manifests include it where those manifests exist.
- The inventory-ledger reference solution remains independent of grader code. Claude bridge's typed JSON-object guard remains inside its independently installable runtime package rather than depending on evaluation scripts.
- Seven animated diagram examples have identical inline controllers. The [animation reference](../skills/diagram-design/references/animation.md) explicitly describes self-contained controllers, so replacing them with external imports would change their standalone behavior.
- Skill-doctor's adapted upstream collection/decoder code and the vendored Pierre bundle were left intact for upstream synchronization. Deliberately defective benchmark starting environments and standalone task shell entrypoints were also retained.
- The audit combined normalized executable-code block scans, JavaScript/TypeScript function AST comparisons, Python function comparisons, inline HTML script comparison, and manual review of near matches. It does not claim that every repeated expression or test assertion should become an abstraction.

## Validation

- `vp run ready`: all nine tasks passed, including formatting, lint, type checking, package readiness, README policy, test boundaries, skill tests, and the full JavaScript/TypeScript suite (**1,476 passed, 10 skipped**).
- Skill suites: diagram design **33**, librarian **14**, TUI tester **12**, and skill doctor **51** passed; unchanged suites may use Vite Task's cached successful results.
- Python evaluation suites with Python 3.13: main **100 passed, 1 skipped**; compaction **14 passed**; LongMemEval **32 passed**. The global Python 3.15 could not build a pinned dependency, so the locked evaluation environment was synchronized with Python 3.13; `vp env doctor` was healthy.
- Both Claude and Codex resume-history hook self-checks passed. The diagram differential checks matched complete outputs, and CLI checks also matched exit status, stdout, stderr, and written bytes.
- Skips: nine opt-in live Claude tests, one zsh-specific test because zsh is absent, and one opt-in Docker evaluation test. No live evaluation series was run.
