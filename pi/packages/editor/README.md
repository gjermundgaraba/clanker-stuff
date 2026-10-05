# editor

Coordinates the native Pi editor, document transactions, and decorations.

## Install

```bash
npm install @clanker-stuff/editor
```

## Usage

Use `acquireEditorHost(ctx)` from cooperating extensions; it installs or joins the shared native editor and returns its host, or `undefined` when another editor owns the session. Register with `host.contribute(slot, value)` for the `editing`, `foreground`, or `border` slot, which returns a release. `currentEditorHost(ctx)` returns the host only while it is still Pi's editor, since another extension can replace it later.

## Requirements

Tested against the repository’s [pinned Pi SDK](../../../pnpm-workspace.yaml). Editor conflicts and unsupported editor layouts appear as one shared status label. With an unsupported layout, `editor.document` is undefined: decorations and modal editing are skipped, while borders, working status, and seeded history keep working.
