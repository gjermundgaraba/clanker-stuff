# Bug triage template

`bug-triage.md` collects suspected defects raised in document bodies, open questions, and observed failures, deduplicated by supported common cause. Each entry gives a product team enough context to decide it without re-reading the documents. Counts follow the evidence rather than a target reduction.

## Building it

1. Inspect suspected defects and open questions in the requested documents and failed checklist items. A full repository build covers the entire set; an extension or correction updates affected findings and their existing duplicates. Useful search terms include "Open questions", "suspected", "looks like a bug", "inconsistent", and "not handled".
2. Keep undetermined behavior in the document's open questions. Observed failures and supported suspected defects become triage entries, including observed failures whose code-level cause is still unknown.
3. Merge by root cause. Fourteen documents saying "a reload mid-way loses the draft" is one entry with fourteen "Raised by" links. Two documents describing different symptoms of one missing handler is one entry.
4. Cite the cause with source paths and lines where established. Retain observed failures whose cause is unknown, label that uncertainty, and avoid inventing a cause or merging observations without evidence.
5. Assign severity and the decision needed. Sort the summary table by severity, then by area.
6. Write the Summary paragraph last: how many were raised, how many remain after merging, how many are high, what the largest clusters are.

## Shape

```
# Bug triage

A consolidated list of the defects and inconsistencies that the feature documents raised in their "Open questions and verification" sections and in their bodies. Each entry is read from {the source repo} and tests; the {n} that have been confirmed {in the running product} carry a **Status** line. {If filed: Every entry was filed as an issue on the source repo on the date (#NNNN–#NNNN); the Issue lines link them.} The list exists so the product team can decide, item by item, whether to fix, to document as intended, or to leave.

## Summary

{One paragraph: counts, clusters, what the high ones have in common.}

| ID | Title | Severity | Area | Decision needed | Issue |
| --- | --- | --- | --- | --- | --- |
| B-01 | {Title as a statement of the wrong behavior} | high | {area} | fix | {link or —} |
| ... | | | | | |

## High

### B-01: {Title}

- **Where the user meets it:** {The situation, in user terms.}
- **What happens / what was expected:** {Both halves, plainly.}
- **Reproduce:** {Numbered or prose steps; name the device if one is needed.}
- **Why (from the code):** {File paths and line ranges; the missing handler, the wrong comparison, the order of operations.}
- **Severity:** `high` | `medium` | `low`. {One clause on why.}
- **Decision needed:** `fix` | `product call`. {What the fix would be, or what the call is.}
- **Raised by:** [{document}]({path}#open-questions-and-verification), [{document}]({path}#{anchor}), ...
- **Status:** {Only if a verification pass touched it: confirmed / not reproduced / document was wrong, on what date, by what means, with the checklist item IDs.}
- **Issue:** {Only if filed: [owner/repo#NNNN](url).}

## Medium

...

## Low

...
```

## Severity and decision

- **high**: loses work, leaves the user in a state they cannot get out of, makes one common action do two things at once, silently does something different from what was confirmed, or affects every feature (a missing global handler).
- **medium**: wrong but recoverable; an undo step missing; an inconsistency between two features that should match; a wrong result in an uncommon path.
- **low**: cosmetic, a copy slip, a quirk only an expert would notice. Group tiny slips into one entry ("Small copy and rendering slips") with a sub-list.
- **fix**: the expected behavior is obvious and the entry says what the fix is.
- **product call**: reasonable people could want either behavior; the entry states both and what each costs.

## Filing upstream

File only when the user authorizes it, using the target repository, issue format, and entry scope already established in the request or repository conventions. Ask only for missing information or authorization that materially affects filing. Create one issue per selected entry, using its title and body (omit the "Raised by" links unless the description repository is public) and applicable repository labels. Add the Issue line to each filed entry, links to the summary table, and an accurate filing summary to the introduction. Follow repository conventions for any authorized commit; do not require a separate commit or a prescribed message.
