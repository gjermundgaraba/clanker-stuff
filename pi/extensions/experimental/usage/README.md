# usage

Shows account usage for supported providers in a status line and on demand.

> [!CAUTION] **Experimental:** This is not a stable daily driver. Breaking changes may happen without notice, and the extension may be removed.

> [!NOTE] This is an unofficial extension that reads usage from provider APIs and local usage data with your own sign-in. It is not affiliated with or endorsed by any supported provider.

## Install

Load `pi/extensions/experimental/usage/index.ts` as a local extension; npm installation is not supported.

## Usage

- Run `/usage` to inspect every available supported provider; the `usage` status line shows the active one.
- Active usage targets the selected physical provider immediately; virtual models follow the latest identifiable physical attempt on the current branch, including failures.

## Configuration

See [provider support and credential handling](docs/providers.md).
