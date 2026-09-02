# usage

Shows subscription usage for supported providers and contributes quota widgets to cooperative footers.

> [!CAUTION] **Experimental:** This is not a stable daily driver. Breaking changes may happen without notice, and the extension may be removed.

> [!NOTE] This is an unofficial extension that reads usage from provider APIs and local usage data with your own sign-in. It is not affiliated with or endorsed by any supported provider.

## Install

Load `pi/extensions/experimental/usage/index.ts` as a local extension; npm installation is not supported.

## Usage

- Run `/usage` to inspect every available supported provider.
- The active provider appears automatically as a native status or cooperative footer widget.

## Configuration

See [provider support and credential handling](docs/providers.md).
