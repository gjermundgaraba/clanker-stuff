# Skill provenance

Canonical provenance lives in `SKILL.md` frontmatter `metadata`, a flat map of
quoted strings supported by the [Agent Skills specification](https://agentskills.io/specification).
Do not add per-skill `UPSTREAM.md`, alignment notes, or duplicated pins.

```yaml
metadata:
  upstream-source: "https://github.com/owner/repo"
  upstream-path: "skills/example/"
  upstream-revision: "<full commit SHA>"
  upstream-relationship: "adapted"
  upstream-license: "MIT"
  upstream-license-file: "LICENSE"
  upstream-baseline-kind: "reconciled"
```

| Field                                       | Meaning                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| `source`                                    | Canonical repository, package, or reference URL                              |
| `path`                                      | Source-repository path, or path inside the package archive                   |
| `revision`                                  | Full Git commit or exact package/version; `unknown` only when unrecovered    |
| `relationship`                              | `copied`, `adapted`, `reference`, or `candidate`                             |
| `license`                                   | Source SPDX identifier, `proprietary`, or `unresolved`                       |
| `license-file`                              | Retained license path relative to the local skill, when applicable           |
| `baseline-kind`                             | `recorded`, `reconstructed`, or `reconciled`                                 |
| `release`                                   | Optional supplementary upstream release label                                |
| `artifact`, `integrity`                     | Required versioned archive URL and published integrity for package baselines |
| `component`                                 | Optional bundled component identifier                                        |
| `reviewed`, `content-url`, `content-sha256` | Optional reference-page observation; not a recoverable baseline              |

Use `upstream-<field>` for the primary source. Additional independent sources use
`upstream-<id>-<field>`, such as `upstream-service-design-revision`. Each copied or
adapted source needs source, path, revision, relationship, license, and baseline-kind.
References need only source and relationship; omit merge-baseline fields.
Keep evidence snapshots distinct from established baselines: a reference-page
hash cannot reconstruct its bytes, and a candidate is not a confirmed origin.

## Updating

1. Stage the recorded baseline and selected incoming immutable source separately.
2. Compare the complete source component with its local adaptation, including
   references, scripts, assets, and metadata; preserve intentional local behavior.
3. Adopt applicable changes and validate affected behavior. For unknown baselines,
   perform a complete two-way reconciliation rather than claiming a three-way merge.
4. Advance only the reconciled source's metadata pin and package integrity together.
   Reconstructed pins need content evidence; reconciled pins are new maintenance
   baselines, not claims about historical imports. Review references editorially.

Keep required licenses and third-party notices. Unresolved terms remain unresolved.
Nested vendored-code provenance and consumer-installation records are separate
from skill metadata and are not removed by this convention.
