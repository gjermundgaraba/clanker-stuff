---
name: arbitrage
description: Delegate bounded implementation to an available external coding worker when doing so saves cost or quota; retain judgment and verification locally.
disable-model-invocation: true
metadata:
  upstream-source: "https://github.com/blader/arbitrage"
  upstream-path: "."
  upstream-revision: "ccfd55098cc9e0b9910bc5c0f67a16a2fd61d5bd"
  upstream-relationship: "adapted"
  upstream-license: "MIT"
  upstream-license-file: "LICENSE"
  upstream-baseline-kind: "reconciled"
---

# Arbitrage

Use the current agent for judgment-heavy work and an available external coding worker for bounded implementation volume. Treat cost and quota as runtime constraints: honor the user's preferred worker, available subscriptions, and host capabilities instead of assuming a particular model or provider is cheaper.

## Routing

| Work                                                   | Default owner          | Why                                                                             |
| ------------------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------- |
| Planning, specifications, and architecture decisions   | Current agent          | These tasks depend on conversation context and judgment.                        |
| Bounded implementation with clear acceptance criteria  | External coding worker | A clear task brief makes the work easy to delegate and independently verify.    |
| Visual validation of UI work                           | Current agent          | The current agent retains the design intent and can compare the result with it. |
| Investigation and root-cause analysis                  | Current agent          | Diagnose first, then delegate the concrete fix when useful.                     |
| Diff review and final verification                     | Current agent          | The worker's report is a claim; the repository and test output are evidence.    |
| Trivial edits discovered during review                 | Current agent          | Dispatch overhead can exceed the work.                                          |
| Work the external worker has demonstrably failed twice | Current agent          | Take over after a corrected retry still misses the acceptance criteria.         |

## Dispatch protocol

1. **Write a proportionate task brief.** Give the worker the objective, relevant constraints, owned files, what not to touch, and observable acceptance criteria. A prompt is enough for a small task; use a shared specification file when the detail or coordination warrants one. Include known verification commands when useful. For visual work, describe the relevant rendered states, interactions, and reference patterns so the current agent can inspect the result. Use pseudocode when the implementation path is fragile.
2. **Choose an available worker.** Prefer the worker the user named. Otherwise choose one that is installed, authenticated, authorized for the task, and economical under the user's current quota or billing constraints. Use its documented non-interactive command and run it in an isolated worktree when practical.
3. **Keep work independent.** If the host supports background processes or subagents, dispatch the bounded task and continue planning or validation work that cannot conflict with the worker's files. Otherwise run the worker synchronously.
4. **Review and verify locally.** Inspect every changed file and check the acceptance criteria using appropriate commands or direct observation. Keep commit, push, and PR actions with the current agent unless the user explicitly delegated them; delegation does not authorize additional external actions.

## Visual validation loop

1. Have the external worker implement the UI from the task brief.
2. Run the application, interact with it, and compare screenshots or rendered states with the design intent.
3. If visual acceptance criteria fail, give concrete corrective feedback within the retry budget below. After that budget is exhausted, complete the corrections locally and verify the result.
4. Review the final diff.

## Failure policy

Dispatch a well-specified task when the worker has the required capabilities and access. Do not reject a suitable worker based only on predicted quality. If it misses the acceptance criteria, give one corrected retry with the observed failure and narrower instructions. If that retry also fails, complete the work locally, preserving sound changes.

## Guardrails

- Use acceptance criteria the current agent can verify. Prefer command-based checks for machine-checkable behavior; use observable rendered states and interactions for visual outcomes.
- Do not assume a model, reasoning level, command, quota, or authentication method; discover what the local environment provides.
- Do not split one coherent unit across workers that share a working directory. Split at an API or worktree boundary.
- Do not treat the worker's completion message as verification.
