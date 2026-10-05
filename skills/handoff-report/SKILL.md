---
name: handoff-report
description: Write a standalone handoff report file for a reviewer, implementer, or stakeholder. Use only when explicitly invoked.
disable-model-invocation: true
---

# Handoff Report

Produce a document that works for someone who has not seen this conversation, this session, or any earlier artifact. State which supporting resources the reader can access; do not assume repo access for a non-code handoff.

## The bar

Read the draft as someone who has not seen the conversation. Include the context, decisions, and constraints needed to understand the handoff; phrases such as "the fix" are fine when their referent is clear within the report.

## Rules

- Describe the final agreed task and scope, including changes to the original request that matter to the handoff. Quote the original wording when useful.
- Use file references the reader can resolve: absolute local paths or relative paths with an explicit base the reader can access. Use stable source links for remote material. For code investigations, name the repo, branch, and commit and prefer commit-pinned links.
- Make **facts/evidence** (verified, with where you checked), **recommendations** (judgment), and **open questions** distinguishable through clear wording or structure.
- When reproduction or executable verification applies, include exact commands and expected results. Otherwise describe the relevant evidence or non-code checking steps; do not invent commands.
- Redact secrets as `[redacted]` — never reproduce credential values, even rotated ones.
- Brief and to-the-point. The reader will not read a wall; push long detail (full logs, big tables, per-file notes) into an appendix and keep the body skimmable.
- State assumptions about the reader explicitly (repo access? which repos? prior domain knowledge?).

## Skeleton

Use only the sections that carry useful information; omit empty sections and code-specific context when it does not apply.

1. **Title + one-line purpose**
2. **Context** — final agreed task and scope, repo/branch/commit, why this matters now
3. **Current state** — what exists today, in the reader's terms
4. **Findings / evidence** — numbered, each with its verification
5. **Recommendations** — proposed actions and tradeoffs
6. **How to verify / reproduce** — exact commands, expected results
7. **Open questions** — what needs a human decision, each with your recommendation
8. **Appendix** — the long tail

Adjust to the audience the user names: an implementer gets steps and boundaries; a reviewer gets evidence and how-to-check; a stakeholder gets outcome and options first. Default audience: independent reviewer.

Write the report to the requested file, the project's existing report directory, or a descriptive `handoff-{topic}.md` in the working directory when no convention exists. Avoid overwriting unrelated files. Return its link; chat alone is not the deliverable.
