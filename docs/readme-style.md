# README style

Publishable Pi package `README.md` files are short installation pages. The root `README.md` catalogs every supported host. Private workspace packages may document their local installation contract instead.

## Goals

Each package README should answer three questions:

1. What does this package add to pi?
2. How do I install it?
3. How do I start using it?

Keep these answers stable, concise, and uniform across packages.

## Canonical metadata

The package's `package.json` is canonical:

- `name` supplies the npm package name used by the installation command.
- `description` supplies the one-line summary.

Do not maintain alternate versions of either value in the README.

## Required package README format

Every publishable extension package must contain a `README.md` with these sections in this order:

````md
# <directory-name>

<package.json description>

## Install

```bash
pi install npm:<package.json name>
```

## Usage

<One physical prose line or up to three short bullets.>
````

The title, summary, `Install` heading, installation command, and `Usage` heading are required. The title must use the package directory name, not the scoped npm name.

Usage must be exactly one physical prose line or one to three `- ` bullet lines. Code blocks, numbered lists, and mixed prose/list content are not allowed. Identify the extension's automatic behavior, primary tool, shortcut, or slash command, and include only the first action a user needs.

## Optional final section

A package may add at most one final section after `Usage`:

- `## Requirements` for software or accounts that users must provide.
- `## Configuration` for a minimal setup instruction or a link to package documentation.

Omit the section when it is not needed. Do not add badges, tables of contents, API references, implementation details, development commands, changelogs, or duplicated feature lists.

## Length limit

A package README must not exceed **30 physical lines**, including headings, blank lines, lists, and fenced code blocks.

The limit is a backstop, not a target. Prefer fewer lines when the package can be explained clearly without them.

## Root README

The root `README.md` should contain:

1. The repository title and a one-paragraph description.
2. A `Pi extensions` table with one row for every publishable package that declares `pi.extensions`.
3. An `Experimental` section, present only while `pi/extensions/experimental/` contains extension packages, with one row per experimental package using the same table columns, followed by the fixed notice line: "Experimental extensions are not published to npm and are not stable daily drivers; they may change incompatibly or be deleted without notice."
4. Links from package names to their package directories.
5. Descriptions sourced from each package's `package.json`.
6. A `Claude Code plugins` table linking each Claude plugin directory.
7. A `Codex plugins` table linking each Codex plugin directory.
8. A one-line `Development` section naming the Node.js requirement and validation command.
9. A `License` section linking to the root license.

List only publishable packages that declare pi extensions in the extension table.

## Deeper documentation

Keep detailed configuration, behavior, security notes, and examples in a package-local `docs/` directory. Link to that material from the optional final README section when users need it to operate the extension.

## Enforcement

README validation must check the canonical title, summary, installation command, required section order, allowed optional section, 30-line limit, and the conditional root `Experimental` section. Keep this repository-specific validation in `scripts/check-readmes.ts`; general Markdown linters do not understand package metadata or this exact template.
