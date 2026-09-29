// Asset names and SHA-256 digests from the official OpenAI Codex release API.
// Keep current using docs/codex-baseline.md#code-mode-host-upkeep.
export const HOST_RELEASE = "rust-v0.159.0";

interface HostAssetIndex {
  [key: string]: readonly [string, string] | undefined;
}

export const HOST_ASSETS: HostAssetIndex = {
  "darwin-arm64": [
    "codex-code-mode-host-aarch64-apple-darwin.tar.gz",
    "40b55636ff9dd1fa010143e11351c6d356feb3f8cacdabde592282f2268be10a",
  ],
  "darwin-x64": [
    "codex-code-mode-host-x86_64-apple-darwin.tar.gz",
    "4a631c18a94c3525778035b97e5c6ea286854e9d835d90a84be651023abf8d00",
  ],
  "linux-arm64": [
    "codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz",
    "4b09c8acbd38edb5080ef8baf7a429fcbb95db6b39f66dcc8fc37afed86c4eb6",
  ],
  "linux-x64": [
    "codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz",
    "f9d22969e793d7320f9ca0c2c0e0d0ec65400ac755ce20b809b64369985be947",
  ],
  "win32-arm64": [
    "codex-code-mode-host-aarch64-pc-windows-msvc.exe",
    "7225ee3ca98be934d45e13c27bc970e0a8479c337493668a9863f048b4022326",
  ],
  "win32-x64": [
    "codex-code-mode-host-x86_64-pc-windows-msvc.exe",
    "cba41f9b6a4ae902b8524c0ee9cb6f2bd863fb556c913fb9d9269d4d78dbd8ac",
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
