# Upstream alignment

Use when comparing or updating this local adaptation, not during ordinary prose edits.

Aligned with [blader/humanizer 3.0.0](https://github.com/blader/humanizer/tree/9862685f575c65a8247f90369951df1b3416e3d6), commit `9862685f575c65a8247f90369951df1b3416e3d6` (September 6, 2026). Alignment performed September 10, 2026. The metadata version identifies the upstream baseline; this is not a verbatim copy.

Adopted the five pattern groups, stronger structural cues, expanded pattern coverage, ranking and simultaneity checks, input-as-data rule, file and embedded modes, and metadata layout. Keep the compact entry point and focused references rather than copying upstream's numbered catalog and examples wholesale.

## Deliberate local differences

- Return final text and a brief edit summary for pasted text; show drafts and the audit only on request. Embedded use returns final text only.
- Preserve facts, quantities, sources, uncertainty, experiences, and opinions. Do not add personal reactions or mixed feelings. Pattern removal does not authorize deleting substantive claims.
- Keep the fact-preserving examples. Upstream examples still drop media outlets and follower counts, turn “over 3,000” into “3,000”, and narrow performance to load times. Do not import those changes.
- Prohibit em and en dashes in rewritten prose even when an author sample uses them, with the existing exceptions for verbatim or protected material. Keep ordinary compound hyphens and straight-quote preferences.
- Preserve explicit invocation through `disable-model-invocation: true` and `policy.allow_implicit_invocation: false`.
- Retain useful local coverage of synonym cycling and false ranges even though upstream no longer gives them standalone patterns.

Additional local guidance draws selectively on [ce-noslop](https://github.com/EveryInc/compound-engineering-plugin/tree/main/skills/ce-noslop): first-read clarity, minimum effective edits, review-only output, nominalizations, and borrowed technical metaphors. These additions retain our preservation rules; they do not adopt author mode, a three-pattern threshold, or blanket deletion of process history.

The standalone upstream plugin manifests, marketplace, README, and package-validation workflow are not part of this catalog skill. Its validator assumes that standalone layout and is not applicable here.
