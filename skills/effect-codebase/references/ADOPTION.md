# Adoption

The order of work for restructuring a package by domain. Read [SHAPES.md](SHAPES.md) first; the target differs by project shape.

## Before moving

- **Scope and permission.** Confirm which packages are in scope and whether import paths or public API may break. In a library, a moved public module is a breaking change.
- **Everything that encodes a path.** Find the places that name source paths: `tsconfig` paths, `package.json` exports, bundler entries, lint and test globs, scripts, documentation links. Each is updated as part of the move. If the same module map is kept by hand in more than one of them, say so and propose giving it one source: derive the copies from it, or make each copy a pattern such as a glob or wildcard. Do that only when the user's request covers it. Leave a list explicit when it is itself a boundary, such as the set of published entries.
- **Rules the old layout enforced.** A folder can encode a rule that nothing else states. Name each such rule and decide how it survives the move (see Precedence in `SKILL.md`).
- **The framework question.** For a framework client whose framework names top-level folders, confirm which guidance governs the top level, asking the user only when neither the repository nor the request says (see SHAPES.md).
- **A baseline.** Run the repository's checks before the first move, so a later failure is attributable. Record any that already fail. Repair one only when the user's request covers it.

When the user asked for a proposal only, do the reading and the path inventory, and leave the baseline run to whoever carries the proposal out. Say so, and mark each decision that depends on an unrun build or check as unverified, naming the check that confirms it.

## Phases

Finish each phase with the repository's checks passing. Where the baseline already had failures, compare the failures themselves and not only the result, and investigate any that is new or has changed. Where a baseline failure keeps a check from verifying the phase, say so and use another check that covers it where one exists. A phase can be empty; say so and move on.

1. **Structure-only moves.** Move files into domain folders and adapters into `platform/`, and update imports. Change no behavior and no public contract. Use the version-control move command so history follows the files. Split a multi-job module only along lines that already exist in the code.
2. **Composition.** Make implementations choosable from the entry files. Functions below them take Layers as input. In a library this phase is usually empty.
3. **Ownership pass.** With the code grouped, look across domains for duplicated vocabularies, state tracked in more than one place, and import directions that SHAPES.md questions. Fix what the user has scoped in; report the rest.
4. **Record it.** Add or update the short architecture description in the README or `AGENTS.md`: the domains with one line each, where ports and adapters live, where Layers are provided, and any override of framework guidance. Keep it to what a newcomer needs to find their way, and check each sentence against the code.
5. **House style.** The practices in [HOUSE_STYLE.md](HOUSE_STYLE.md) that fit the project, one at a time and in the order given there. Include them in a proposal with a verdict for each: apply, apply in adapted form, already in force, already in force in adapted form, or do not apply. Carry out the ones the user's request covers.

A contract change, such as reshaping errors, is not part of the structural phases. Do it as its own step after phase 1, in a single change that updates every caller and client.

## Ports during a move

Do not add a port for every external call. Apply the criterion in `SKILL.md` to each candidate. Remove an existing interface that only forwards to another service only when the user's request covers that change, and keep the removal out of the structure-only step. Otherwise move it with the rest and report it as a candidate for removal.

## Done

The agreed steps are complete, the checks pass, and the recorded description matches the code. Where a baseline failure left part of the work unverified, the work is finished and its validation is not: name the part and the check that would confirm it. Report what moved, what was left in place and why, which house-style practices are now in force, and any ownership or contract problems found but not fixed.
