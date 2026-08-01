# Extension structure

Every pi extension package follows the same layout. `ask-question` is the
small reference example, `footer` the large one.

```
<name>/
  README.md  LICENSE  package.json
  index.ts          ← thin entry: registration and wiring only
  <concern>.ts      ← flat, one file per concern (core.ts, search.ts, state.ts, …)
  <family>/         ← subdirectory only for 3+ peer modules (adapters/, profiles/, commands/)
  docs/             ← all prose beyond the README: design notes, research, results
  tests/
    <module>.test.ts   ← mirrors the source module it covers
    helpers.ts         ← shared test setup
    *.integration.test.ts / *.smoke.test.ts for higher layers
```

Rules:

- `index.ts` stays thin. Logic lives in flat single-concern modules at the
  package root; `index.ts` imports them and registers with pi.
- Single-file extensions are the degenerate case: `index.ts` plus
  `tests/<name>.test.ts` is fine. Do not force splits on small packages.
- No loose markdown at the package root besides `README.md`; everything else
  goes in `docs/`.
- `package.json` `files` must list every shipped source file plus `README.md`
  and `LICENSE` — a module missing there breaks the published package.
- Name new test files after the module they cover and shared test setup
  `helpers.ts`. Existing behavior-named test files are not worth renaming.
