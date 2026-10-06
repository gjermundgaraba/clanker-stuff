# Reusable skills

Reusable coding, review, writing, visualization, and agent-tool workflows. Each
child folder with a `SKILL.md` is a complete skill, including its references,
scripts, assets, and host metadata.

## Ownership

This is the canonical source for reusable skills, including `orchestrate`.
Edit skills here; installations link these complete folders into each host.

Package-owned skills stay with their extension or plugin.

## Installation

Link each selected skill folder into both `~/.agents/skills/` for Codex and
`~/.claude/skills/` for Claude Code. Link the whole folder, not individual files.
Review existing links before replacing them; do not overwrite unrelated
installed skills. Codex uses `~/.agents/skills/`, so do not also install the same
skill under the legacy `~/.codex/skills/` location.

User-invocation-only skills are called with `$skill-name` in Codex or
`/skill-name` in Claude Code. Keep their explicit-invocation policy in both
`SKILL.md` and `agents/openai.yaml`; see [AGENTS.md](AGENTS.md).

## Upstream provenance

Source identities and baseline revisions live in `SKILL.md` metadata; licenses
travel with the skill. Follow the [provenance convention](../docs/skill-provenance.md)
when adding or updating them.

## Helper requirements and validation

Skills with a `package.json` declare their helper dependencies. `vp install`
supplies these in this repository; standalone installations must follow the
skill's setup instructions, such as the [product-description helper](product-description/README.md).

`vp run ready` includes the Python diagram and librarian suites as well as
JavaScript/TypeScript helper tests. Python helpers require Python 3.10 or newer;
`vp run check:skills` runs just the Python suites.
