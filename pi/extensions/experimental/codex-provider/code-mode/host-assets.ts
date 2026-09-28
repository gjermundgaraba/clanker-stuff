// Asset names and SHA-256 digests from the official OpenAI Codex release API.
// Keep current using docs/codex-baseline.md#code-mode-host-upkeep.
export const HOST_RELEASE = "rust-v0.158.0";

interface HostAssetIndex {
  [key: string]: readonly [string, string] | undefined;
}

export const HOST_ASSETS: HostAssetIndex = {
  "darwin-arm64": [
    "codex-code-mode-host-aarch64-apple-darwin.tar.gz",
    "19363918da75f5d2b805b6fffafd84ea3c8976e03e751192c04aea5bd70d4ab4",
  ],
  "darwin-x64": [
    "codex-code-mode-host-x86_64-apple-darwin.tar.gz",
    "b4a7ecd9808f0bcb673f3fb70261528c646fdb0aee1f89798550ca8f7ea31b48",
  ],
  "linux-arm64": [
    "codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz",
    "541bebec84765ad0d21a3591bed18e251dc1cf164cef203e05002fb045ab1cec",
  ],
  "linux-x64": [
    "codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz",
    "5455c64be4ba371444710895aff6d74d653985a3bfc454a8b7fe42d6e6d11e3d",
  ],
  "win32-arm64": [
    "codex-code-mode-host-aarch64-pc-windows-msvc.exe",
    "c7ba653144bcb54b527be766ebe9fcfa7e06763e211f24577ec6dfec9c39e21b",
  ],
  "win32-x64": [
    "codex-code-mode-host-x86_64-pc-windows-msvc.exe",
    "7068b4c0d00bab73f279f67ea6715c6051add6d8e0ed5373a9e146c2d0444290",
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
