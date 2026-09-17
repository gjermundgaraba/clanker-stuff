# editor

Coordinates the native Pi editor, document transactions, and decorations.

## Install

```bash
npm install @clanker-stuff/editor
```

## Usage

Use `acquireEditorHost(ctx)` from cooperating extensions; it installs or joins the shared native editor and returns its host, or `undefined` when another editor owns the session or Pi's editor internals are unsupported. Register with `host.contribute(slot, value)`, which returns a release.

## Requirements

Pi 0.85.0. Editor conflicts and unsupported Pi versions appear as one shared status label and leave a working prompt; callers skip editor-dependent features.
