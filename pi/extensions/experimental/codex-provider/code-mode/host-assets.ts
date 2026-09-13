// Asset names and SHA-256 digests from the official OpenAI Codex release API.
// Keep current using docs/codex-baseline.md#code-mode-host-upkeep.
export const HOST_RELEASE = "rust-v0.154.0";

interface HostAssetIndex {
  [key: string]: readonly [string, string] | undefined;
}

export const HOST_ASSETS: HostAssetIndex = {
  "darwin-arm64": [
    "codex-code-mode-host-aarch64-apple-darwin.tar.gz",
    "500ee2a02ea598ae519052e7d7d8e201d1db01986f30c214ef4143645dc86fad",
  ],
  "darwin-x64": [
    "codex-code-mode-host-x86_64-apple-darwin.tar.gz",
    "a0fa6141e591f44dc2d86a589cfe797212317bfb9fa3a6c73131e4dbb93387fe",
  ],
  "linux-arm64": [
    "codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz",
    "20aefa302c2022b496e32911bf954a5f76c7fd749c6bdb9fbd711e32b66dcbfa",
  ],
  "linux-x64": [
    "codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz",
    "a68df7cca23c6da7cde175677df7de61c73a234add1333a1254b86d641af01f7",
  ],
  "win32-arm64": [
    "codex-code-mode-host-aarch64-pc-windows-msvc.exe",
    "1f33d0eaf0522bf067cdf1899c789194411c70fd1cc22eda4a46025c0835193f",
  ],
  "win32-x64": [
    "codex-code-mode-host-x86_64-pc-windows-msvc.exe",
    "7b4987007702973dfeb49ec9a0c11f737488890e208ccb04f7a147769c4bb1f1",
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
