# codex-http

Shares scoped ChatGPT infrastructure routing cookies across Pi extensions.

## Install

```bash
npm install @clanker-stuff/codex-http
```

## Usage

Use `fetchCodexHttp` for Codex HTTP requests. Only HTTPS first-party `__oailb` cookies are retained in memory; automatic redirects are rejected and explicit manual handling is preserved.
