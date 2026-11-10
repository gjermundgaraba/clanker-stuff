# editor

Shares the native Pi editor between extensions for text highlights, border content and seeded history.

## Install

```bash
npm install @clanker-stuff/editor
```

## Usage

Use `acquireEditorHost(ctx)` from cooperating extensions; it installs or joins the shared native editor and returns its host, or `undefined` when another editor owns the session. Register with `host.contribute(slot, value)` for the `highlight` or `border` slot, which returns a release. `currentEditorHost(ctx)` returns the host only while it is still Pi's editor, since another extension can replace it later.

## Requirements

Tested against the repository’s [pinned Pi SDK](../../../pnpm-workspace.yaml). The editor relies on two private parts of Pi's editor, checked separately: its paste store, so that pastes expand in one pass and a paste containing `[paste #N]` stays literal, and its layout, which highlights use. Editor conflicts and unsupported internals appear as one shared status label. Without the paste store, Pi's own expansion applies. Without the layout, highlights are skipped. Borders, working status and seeded history keep working either way.
