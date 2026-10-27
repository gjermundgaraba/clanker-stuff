# Dependencies

How an Effect project on pnpm and Vite+ declares, pins and upgrades its dependencies. The rules split by what a package is: a published library, whose ranges its consumers resolve; a published CLI or app, whose own tree is what runs; and the workspace that builds either. An unpublished package follows the workspace rules alone: its lockfile decides what runs.

## Rules

| # | Rule | Standing |
| --- | --- | --- |
| 1 | A published library takes `effect` and every `@effect/*` package as `peerDependencies`, never `dependencies`, and pins the version it is tested against in `devDependencies`. | Effect practice: every `@effect/*` companion and every Effect 4 library surveyed declares `effect` as a peer; `@effect/language-service` warns on duplicate copies. |
| 2 | A library's `effect` peer is `~4.0.<floor>` when it imports any module outside the `effect` package's stable surface or any `@effect/*` package, and `^4.0.<floor>` only when it uses stable APIs alone. `@effect/*` peers take the same range. The floor is the oldest patch whose APIs or fixes the library needs. Raise it only for such a need, and record the raise as breaking. | Effect's stability policy: unstable APIs, which include every module outside the `effect` package, may break in a minor release. The floor rule is house choice. |
| 3 | A library built on another 0.x library, such as `@gjermundgaraba/effect-actions`, takes it as a peer `^0.<minor>.0`, the minor it is tested against. Never a `dependency`, and never a range spanning minors. | npm semver: `^0.18.0` is `>=0.18.0 <0.19.0`, and a 0.x minor may break. A second copy of such a library splits its services and error classes. |
| 4 | Write a published library's peer ranges literally in its `package.json`, not through `catalog:`. | pnpm publishes a catalog entry as written, so an exact catalog pin becomes an exact peer. |
| 5 | A published CLI or app takes Effect as `dependencies` pinned exactly, through the catalog, and also pins every `@effect/*` package it reaches through another companion's caret range, such as `@effect/platform-node-shared`, equal to `effect`. | Renovate's convention for applications. The extra pins keep an npm install on one `effect`: a newer `platform-node-shared` would demand a newer `effect` and nest a second copy. |
| 6 | Declare pnpm in `devEngines.packageManager` alone, never `packageManager`. Keep `engines` the consumer-facing floor, lower than the development version on purpose. | pnpm docs: `packageManager` is the legacy field and only one may be present. Vite+ reads either. |
| 7 | Set `minimumReleaseAge: 1440` explicitly in `pnpm-workspace.yaml`. | pnpm's default since v11 is the same, but `vp migrate` maintains its toolchain exclusions only when the setting is explicit. |
| 8 | `minimumReleaseAgeExclude` names package families only: the entries `vp migrate` writes, the owner's own scopes (`@gjermundgaraba/*`, `@gjermundgaraba-designs/*`), and `effect` with `@effect/*`. Another family needs a comment saying why. No `pkg@version` entries; when a one-off is unavoidable, set `minimumReleaseAgeExcludePrune: true` so it leaves with its version. | House choice. Effect is exempt for now so its lockstep releases land the day they publish; this may change. |
| 9 | `vp migrate` owns the toolchain pins: `vite-plus`, the `vite` alias to `@voidzero-dev/vite-plus-core`, the `vite@*` and `vitest@*` overrides, and a `vitest` pin only where it keeps one. Pin no separate `oxlint`, `oxfmt` or `tsdown`. Set `catalogMode: prefer`. | Vite+ docs and its `vp create` template. `@oxlint/plugins` for local lint rules is not a second oxlint; keep it at the bundled oxlint's version. |
| 10 | Every `uses:` in workflows and composite actions is pinned to a full commit SHA with a trailing `# vX.Y.Z` comment. `voidzero-dev/setup-vp` takes no `version` input: it reads `vite-plus` from the catalog. | GitHub's security hardening guidance; setup-vp README. |
| 11 | `.node-version` holds the one exact development Node version. CI reads it with `node-version-file: .node-version`; workflows, `devEngines.runtime` and `engines` pin no other exact Node. `engines` stays the consumer-facing range, and a published package's CI also tests its `engines` floor. | Vite+ resolves Node from `.node-version` first; setup-vp and setup-node read the file. One exact copy, as rule 6 keeps one pnpm declaration. |
| 12 | A Dockerfile builds and runs on `node:<.node-version>-trixie-slim@sha256:<digest>`, tag and digest together. It installs pnpm at the version `devEngines.packageManager` names, read from `package.json` during the build, runs `pnpm install --frozen-lockfile` with a BuildKit cache mount, and ships a production-only tree (`pnpm deploy --prod` or `pnpm prune --prod`). No Vite+ base image. | A digest makes the base image immutable, as a SHA pins an action. The base image is the one Node pin a Dockerfile cannot read from `.node-version`, so it moves in the same commit. Debian trixie is the current stable release. A Vite+ image is a second toolchain pin that drifts. |

## Upgrading

- **Vite+.** Run `vp migrate --no-interactive`, read its diff, and revert anything it changed inside a vendored subtree. Then validate.
- **Effect.** Move `effect` and every lockstep `@effect/*` package to one version together; independently versioned tools such as `@effect/tsgo` move to their own latest. A library changes only its development pins unless rule 2 calls for a new floor.
- **Everything else.** `vp outdated -r`, then edit catalogs and manifests by hand so each change stays its own commit. A package whose new version breaks the build and needs more than a fix is held back and reported.
- **Node.** Change `.node-version`, and every Dockerfile's `FROM node:` tag and digest, in the same commit. Resolve the digest with `docker buildx imagetools inspect node:<version>-trixie-slim`.
- **Actions.** `vp exec pnpm update --include-github-actions` moves SHA-pinned actions and their comments. Read the release notes of any major before accepting it.
- After each step run the repository's full validation, and `vp install --frozen-lockfile` before the last commit.

## Review

Report each departure from a rule with the file and line, and what it costs: a duplicate `effect` or 0.x library in a consumer's tree, a peer range that admits an untested minor, an exclusion list that must be edited on every bump. A departure the repository's `AGENTS.md` records with a reason is reported as required, not as a finding.

## Sources

- Effect versioning and stability: `MIGRATION.md` ("Versioning", "Unstable Module System") and `README.md` ("Long-term support") in [Effect-TS/effect](https://github.com/Effect-TS/effect).
- Catalog publishing and `catalogMode`: <https://pnpm.io/catalogs>, <https://pnpm.io/settings/other>.
- Release age and its exclusions: <https://pnpm.io/settings/dependency-resolution#minimumreleaseage>, <https://pnpm.io/supply-chain-security>.
- `devEngines.packageManager`: <https://pnpm.io/package_json#devenginespackagemanager>, <https://pnpm.io/package-managers>.
- Vite+ pins, migrate and setup-vp: `node_modules/vite-plus/docs/guide/migrate-rules.md`, `upgrade-project.md`, `package-management.md`, `ci.md`; <https://github.com/voidzero-dev/setup-vp>.
- Pinning applications and libraries: <https://docs.renovatebot.com/dependency-pinning/>; caret ranges: <https://github.com/npm/node-semver#caret-ranges-123-025-004>.
- Actions pinning: <https://docs.github.com/en/actions/reference/security/secure-use>; `pnpm update --include-github-actions`: <https://pnpm.io/cli/update>.
