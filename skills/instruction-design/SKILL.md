---
name: instruction-design
description: Write or review agent instructions using the Rethinking Skills and Prompts guidance. Use only when explicitly invoked.
disable-model-invocation: true
metadata:
  upstream-source: "https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra"
  upstream-relationship: "reference"
  upstream-reviewed: "2026-10-06"
  upstream-content-url: "https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra.md"
  upstream-content-sha256: "a1deee4c0b3ca16a20385c27f0692e22d5150fdec81710c04742dd5da29f0468"
---

# Instruction Design

Write, revise, or review only the skills, AGENTS.md, CLAUDE.md, or prompts requested by the user. Preserve their intent and operational constraints. For reviews, explain concrete issues and useful changes without editing unless requested. For writing or revision tasks, apply the guidance directly.

- **Discovery:** Keep descriptions short and specific about when the skill helps. Narrow broad triggers and avoid competing claims that attract unrelated tasks.
- **Progressive disclosure:** Keep shared guidance and routing in the root. Move substantial conditional workflows and examples into references, with instructions to read only what the task needs. Keep a simple skill self-contained.
- **Scaffolding:** Prefer outcomes and decision criteria over elaborate recipes. Retain exact sequences when they protect a real operational invariant.
- **Context:** Route to repository documents by the decisions they inform. Avoid requiring a full repository map or a stack of documents before every edit.
- **Verification:** Preserve checks that establish relevant behavior or contracts. Scale testing to the task and repeat when new changes, failures, or unresolved concerns justify it.
- **Permissions:** Preserve meaningful approval boundaries and authorization already given. Remove redundant checkpoints that interrupt work within the authorized scope.
- **Completion:** Define the requested endpoint, including implementation, observation, fixes, or reporting where applicable. Avoid stopping at a first pass when authorized work remains.

Treat observations about GPT-6 Astra as model-specific context. Apply behavioral advice only where it fits the intended consumers, including other Codex models and Claude Code; do not remove useful verification or scope constraints solely because Astra needs less prompting.

Read [the local rationale](references/rethinking-skills-and-prompts.md) when its reasoning or examples would help resolve a design choice. It summarizes reference-only guidance; it is not an article transcription. Consult the original article identified in the skill's metadata when its current wording or model-specific claims matter. Do not expand the task or audit unrelated instructions merely because the article suggests it.
