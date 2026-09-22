# editor

Coordinates the native Pi editor, document transactions, and decorations.

## Install

```bash
npm install @clanker-stuff/editor
```

## Usage

Use `acquireEditorHost(ctx)` from cooperating extensions; it installs or joins the shared native editor and returns its host, or `undefined` when another editor owns the session or Pi's editor internals are unsupported. Register with `host.contribute(slot, value)` for the `editing`, `foreground`, `border`, or `status` slot, which returns a release.

## Requirements

Tested against the repository’s [pinned Pi SDK](../../../pnpm-workspace.yaml). Editor conflicts and unsupported editor layouts appear as one shared status label and leave a working prompt; callers skip editor-dependent features.
