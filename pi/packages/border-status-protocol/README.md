# border-status-protocol

Shares the editor-border status contract and producer client across Pi extensions.

## Install

```bash
npm install @clanker-stuff/border-status-protocol
```

## Usage

Use `createBorderStatusClient(pi, { owner })` to set or clear keyed statuses; attach on session start/tree navigation and dispose on shutdown. See the [producer guide](docs/producers.md).
