# Verification templates

Two kinds of file: `verification/README.md` (the protocol) and one checklist per cluster of documents. Clusters follow the README structure (for example: foundations + the hardest area, the other tools + objects, actions + UI, cross-cutting).

## verification/README.md

```
# Observed verification

The feature documents were written from the code and the tests. This directory is the protocol for checking them against the running product, one observable claim at a time.

## What is here

| File | Covers |
| --- | --- |
| [{cluster}.md]({cluster}.md) | `{area}/*` and `{area}/*` |
| ... | ... |

Each file has one table per document. Each row is an item with a stable ID (`INVITE-07`, `INIT-12`), a priority, what it needs (a device, a role, a network condition, a second user), the claim with a link to the document section, the setup, numbered steps, the expected result, and a Result column for recording the observation. Design questions and matters requiring a product decision belong under "Requires a decision". Observable claims that cannot currently be exercised remain checklist items marked `blocked` or unrun.

Priorities: **P1** is an established fact, a claim many documents depend on, or a suspected bug; **P2** is an ordinary claim; **P3** is a number, a color, or a timing.

## How to run a pass

1. {Bring up the surface: the command, the URL, how to get a clean state for the pass and clean up afterward.}
2. Confirm the tested build/commit and compare it with each document's `Source provenance: {repo} commit {sha}`. `git rev-parse --short HEAD` identifies the checkout; separately confirm that the running build comes from it. Record any mismatch so drift is distinguishable from defects.
3. Use the linked document section to resolve a claim's context when needed. Choose a method that exercises and observes it on the identified build; reading source or tests alone is not observation.
4. Work through P1 first across all files, then P2, then P3.
5. Record `pass`, `fail`, or `blocked` in the Result column, with evidence and method (or a link to shared pass evidence), and a reason for failures or blockers. A fail is something the document says that the product does not do; a blocked item could not be run (no device, no second user, a prior failure in the way). Continue independent items; do not infer success for unrun claims.
6. File every fail in [`bug-triage.md`](../bug-triage.md): if the entry exists, add a Status line quoting the item ID; if not, add an entry with the item ID under "Raised by". A fail is not automatically a product bug; sometimes the document is wrong, and the fix is to the document. Say which in the Status line.
7. Update each tested document's separate `Observed verification` status with the pass date, tested build/commit, method, coverage, results, and checklist link; retain its source provenance. When every P1 and P2 item has been observed and either passed or failed with a linked triage record, change its row in the [coverage table](../README.md#coverage) to `verified`. Blocked or unrun P1/P2 items keep it `drafted`. Record unobserved P3 items as coverage gaps. `verified` records observation coverage, not absence of defects. Automation qualifies when it exercises the claims; human acceptance is a separate status only when required by the user or repository.

## Devices and conditions

{One bullet per value the Device column uses (mouse, keyboard, touch, pen, a second user, specific files to drop, a readonly account, an admin role, offline, a piped stdout, a second device), with how to get it and any trap (a second tab is not a second browser; an offline toggle in devtools does not fail an in-flight websocket the way pulling the cable does; a trackpad reports inertial scrolling that a mouse does not; `--no-color` and a pipe are not the same condition).}

## Driving the product from a console or script

{If the surface exposes a handle (a global app object in the browser console, an inspector, a state dump command), explain which claims it can establish: setting up a starting state, reading state after an interaction, or observing stored results. Exercise the actual input path for input claims; setting state directly does not verify the gesture that would produce it. Record limitations such as occluded rendering or synthetic key events bypassing shortcuts. For a CLI, scripts can exercise commands and observe output and exit codes. TTY, visual, timing, and interaction claims need methods that capture those properties, whether operated by a human or an agent. A test run establishes only the claims it actually exercises on the identified build.}

## Results so far

{Nothing yet, or: what pass was run, when, on what, against which commit, by what means, how many items, how many passed and failed, which triage entries the failures map to, and what the pass did not cover. Be exact about limits: "with the window occluded (so nothing visual was checked)". Say which documents, if any, are marked verified and why none are if none.}
```

## A checklist file

```
# Verification: {cluster name}

How to run this file: {one paragraph: the fresh-state setup specific to this cluster, which preferences must be at defaults, how to clear between sections, what each value in the Device column (`mouse` / `keyboard` / `touch` / `pen` / `sync`, or `admin` / `offline` / `piped`) means}.

## {area}/{document}.md

| ID | P | Device | Claim | Setup | Steps | Expected | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| {PREFIX}-01 | P1 | mouse | {One sentence, the claim as the document states it} ([{section name}](../{area}/{document}.md#{anchor})). | {The scene and mode to start from.} | 1. {Step.}<br>2. {Step.}<br>3. {Step.} | {What is seen or read back, specific enough that pass/fail is unambiguous.} | — |
| {PREFIX}-02 | P2 | keyboard | ... | ... | ... | ... | — |

Requires a decision:

- {A design question or product decision the document raised; link to it.}
```

### Rules for items

- One observable claim per row. If a document sentence contains two claims, it is two rows.
- IDs are `{PREFIX}-NN`, prefix per document (`INVITE`, `INIT`, `COMPOSE`), numbered in document order, never renumbered once a pass has used them.
- The claim links to the section it summarizes. The section is the authority; the row is the summary.
- Setup states the starting state precisely (which record, which role, which fields filled; which files on disk, which flags, which environment; how many objects, which selected, which mode, which preferences).
- Steps are numbered, imperative, and include exact distances, keys, and timings where the claim depends on them ("Type a 65-character name", "press Ctrl+C within 1 s of the first progress line", "drag 200 px right", "wait 500 ms before releasing").
- Expected describes what is seen _and_ what is not ("the dialog closes, no toast, the list is unchanged"; "exit code 2, nothing on stdout, one line on stderr"). For suspected bugs, say "Record what happens" and mark the row "(suspected bug)".
- Every suspected bug in the document gets a P1 row, even if the tester can only record the result.
- Every applicable cancel/interrupt or modifier table cell gets a row, including "no effect" claims with an expectation describing what remains unchanged. For a "not applicable" cell, assess the stated reason and verify any observable claim it makes; do not invent steps for a condition or phase that does not exist.
- Numbers, colors, and timings are P3 unless many documents depend on them (the threshold that separates the short path from the extended one is P1).
- The Result column is `—` until a pass fills it. Results are recorded in place with evidence and method (or a shared evidence link), plus reasons for failures or blockers. Preserve prior observation history when a claim changes; rerun affected items before treating earlier success as evidence for the revised claim.

Expect on the order of a few dozen items per document; the count is driven by the document, not a target.
