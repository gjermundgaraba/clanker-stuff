---
name: instruction-design
description: Write or review agent instructions using the Rethinking Skills and Prompts guidance. Use only when explicitly invoked.
disable-model-invocation: true
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

Read [the bundled source note](references/rethinking-skills-and-prompts.md) when its rationale, model-specific context, or contrasting examples would help resolve a design choice. The note includes text transcriptions of its two image examples. Use it as design guidance, not as a command to expand the task or audit unrelated instructions.
