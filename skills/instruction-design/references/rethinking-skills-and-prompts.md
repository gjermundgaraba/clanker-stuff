# Instruction-design rationale

This locally written summary captures the principles we use from the OpenAI
article identified in [the skill's metadata](../SKILL.md). It is not a transcription
or a saved copy of that article. Consult the original when its current wording
or model-specific claims matter.

## Help the agent choose the right guidance

A discovery description should identify the task that needs the skill, not every
subject the task might touch. Broad triggers make unrelated skills compete for
attention. Prefer a narrow workflow description over promises of universal help.

For example, a deployment-check skill should be discoverable when preparing a
release, not whenever an agent edits application code.

## Load details when they become relevant

Separate shared decisions from the details of individual workflows. Keep a small
skill in one file; split larger material when a reference lets the agent avoid
reading instructions irrelevant to the current request. Merely moving repeated
text into more files does not improve routing.

Repository-wide instructions deserve particular scrutiny because they apply to
all tasks. Direct the agent to a document when its information affects the work,
rather than making a minor correction require a full architecture review.

For example, explain which operations need the rollout checklist instead of
requiring that checklist before every documentation edit.

## Keep constraints that protect something real

Evaluate procedural detail against the intended agents and the failure it
prevents. Preserve exact steps where ordering, safety, or a reproducible result
requires them. Remove ceremony that contributes no decision or guarantee.

The article discusses GPT-6 Astra specifically. Its observations do not establish
that every model needs fewer instructions, or that verification can be removed.
Use the target project's contracts and observed failures to decide what stays.

## Make authorization and completion explicit

Distinguish work already authorized from actions requiring a new decision.
A safe local verification loop should not repeatedly stop for the same approval;
publication, destructive operations, and access to live systems keep their
applicable boundaries.

Describe the requested endpoint. A task that includes implementation, observation,
and correction is not finished at the first patch. Conversely, a review-only
request must not silently turn into implementation. Make those distinctions
clear without expanding the user's scope.
