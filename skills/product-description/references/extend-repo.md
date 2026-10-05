# Extend or revise an existing repository

Use the current assignment and repository conventions to scope the work. Read the affected document, relevant README scope/template sections, and the glossary or foundations the change depends on. Consult `goal.md` when choosing work, resolving shared fact ownership, or coordinating assignments; consult the pilot when a new document needs a structural exemplar. A narrow correction does not require reloading all orientation documents.

## Source revision

Establish the inspected source revision and follow the repository's recorded versioning policy. For pinned documentation, inspect the pinned revision without altering the source working tree. For documentation that follows changes, cite the new inspected revision on affected documents and identify any intentionally older coverage. Do not silently mix revisions or rewrite untouched provenance. Ask only when the policy and request leave a material versioning choice unresolved; continue independent work meanwhile.

## Add or revise documentation

- For a new feature, add it to the README structure and coverage table, then draft it using the established skeleton and [document-template.md](document-template.md) where needed. Preserve the shared variant/interrupt lists and fact ownership.
- For a correction, update the affected explanation and references. Change foundations or shared conventions only when the evidence requires it, then reconcile dependent documents. Preserve other contributors' edits.
- Integrate new terminology through the designated glossary owner. During parallel work, drafting workers propose definitions and edit only their assigned documents; the owner updates the glossary and shared tracking files.
- Keep checklist and triage records aligned with substantive changes. Preserve existing IDs; append new IDs rather than renumbering used ones. Retain prior observation history, but do not treat an earlier pass as evidence for a changed claim. Mark affected coverage as needing a new pass when its existing evidence no longer supports it. Editorial corrections that leave claims unchanged do not invalidate observation evidence.

For new or changed claims, use [verification and triage](verify-triage.md) as needed to update existing checklists and findings. Run observation work when included in the request; source-based drafting alone is not observed verification. Do not create an unrelated verification program for a wording correction.

## Check and finish the requested scope

Check changed documents and affected dependencies for consistent terminology, fact ownership, tables, and provenance. Use `node {skill-directory}/scripts/check-links.mjs {description-repo}` when links or document structure change; resolve the skill directory from the loaded `SKILL.md`. Address failures caused by the work and identify unrelated gaps without expanding the assignment.

Update applicable coverage, checklist results, and triage status. Revisit missing evidence, unresolved questions, or inconsistencies rather than scheduling an automatic second pass. Follow repository conventions for authorized commits of coherent work. Finish the requested documents and any requested observation/triage work, reporting unresolved claims or unavailable observations without abandoning independent work.
