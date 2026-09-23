// Asset names and SHA-256 digests from the official OpenAI Codex release API.
// Keep current using docs/codex-baseline.md#code-mode-host-upkeep.
export const HOST_RELEASE = "rust-v0.156.1";

interface HostAssetIndex {
  [key: string]: readonly [string, string] | undefined;
}

export const HOST_ASSETS: HostAssetIndex = {
  "darwin-arm64": [
    "codex-code-mode-host-aarch64-apple-darwin.tar.gz",
    "2625d023e2b6e03d2bcc437a3e0e0831c25d3c722d2854638a8e74921ff79bd9",
  ],
  "darwin-x64": [
    "codex-code-mode-host-x86_64-apple-darwin.tar.gz",
    "fc968d9e7212d7fbb1e1546d2836f3b07c5f388109c05b8428c1f3f3091d7209",
  ],
  "linux-arm64": [
    "codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz",
    "40198138b03798ffa8c0da4c827a8ca5896774ea104b7110c2a2c0c7560cbe94",
  ],
  "linux-x64": [
    "codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz",
    "a929daa9f6a0bddc00c0c9e6402df117b125acd96f9d554f6c99c32c7e66c608",
  ],
  "win32-arm64": [
    "codex-code-mode-host-aarch64-pc-windows-msvc.exe",
    "1aac957f7973fbb75885fdb3779584769f060b954e3fabc2aea15fd7a382fbae",
  ],
  "win32-x64": [
    "codex-code-mode-host-x86_64-pc-windows-msvc.exe",
    "0f83a73dc6d511d43bd3e52cc0a999cb383c19c645ef3fbd8fbdaddde3088138",
  ],
} as const;

export const codeModeHostBinaryName = (platform: string) =>
  platform === "win32" ? "codex-code-mode-host.exe" : "codex-code-mode-host";

export const resolveCodeModeHostAsset = (
  platform: string,
  arch: string,
): readonly [string, string] => {
  const asset = HOST_ASSETS[`${platform}-${arch}`];

  if (!asset) {
    throw new Error(`Unsupported code-mode platform: ${platform}-${arch}`);
  }

  return asset;
};

export const hostAssetUrl = (assetName: string) =>
  `https://github.com/openai/codex/releases/download/${HOST_RELEASE}/${assetName}`;
