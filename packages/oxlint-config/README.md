# oxlint-config

Shares the Ultracite and Effect Oxlint preset, its exceptions and a rule that keeps prose out of comments.

## Install

```bash
pnpm add -D @clanker-stuff/oxlint-config ultracite @effect/tsgo oxlint vite-plus
```

## Usage

Export `config({ ... })` from `oxlint.config.ts`, or pass it to `lint` in `vite.config.ts`; it returns the whole Oxlint config, and your options merge after the shared values.

## Configuration

The [preset guide](https://github.com/gjermundgaraba/clanker-stuff/blob/main/packages/oxlint-config/docs/preset.md) lists the options, example configs, every shared exception with its reason, and the comment rule's allowed forms.
