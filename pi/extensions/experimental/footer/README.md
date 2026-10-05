# footer

Lays out built-in widgets and native extension statuses in the footer and editor border.

> [!CAUTION] **Experimental:** This is not a stable daily driver. Breaking changes may happen without notice, and the extension may be removed.

## Install

Load `pi/extensions/experimental/footer/index.ts` as a local extension; npm installation is not supported.

## Usage

- Run `/footer` to edit the layout as JSON, or `/footer reset` to restore the default.
- Run `/footer inspect` to see each widget's value, placement, and recent errors.
- Extensions publish values with `ctx.ui.setStatus()`; place them as `status:<key>`.

## Configuration

See [footer configuration](docs/configuration.md) and [status producers](docs/statuses.md).
