// Asset names and SHA-256 digests from the official OpenAI Codex release API.
// Keep current using docs/codex-baseline.md#code-mode-host-upkeep.
export const HOST_RELEASE = "rust-v0.159.2";

interface HostAssetIndex {
  [key: string]: readonly [string, string] | undefined;
}

export const HOST_ASSETS: HostAssetIndex = {
  "darwin-arm64": [
    "codex-code-mode-host-aarch64-apple-darwin.tar.gz",
    "4f9f3c0e3eabe9bee128946bb04cc9523423e82f9751880b7f03d41aa9e482f2",
  ],
  "darwin-x64": [
    "codex-code-mode-host-x86_64-apple-darwin.tar.gz",
    "cfe7d17004ecaaa7c7b9084d89746bc99e815ee4b39a1b5d686b430b6b067cc1",
  ],
  "linux-arm64": [
    "codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz",
    "011967737e5eef730963dd63636e1006408ced43cbb3d6ca68c5c233998d6430",
  ],
  "linux-x64": [
    "codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz",
    "fb6b0c4a7b24ed0728d1208ebc0061383da60debc6d61cf63e02c48ac7f7630f",
  ],
  "win32-arm64": [
    "codex-code-mode-host-aarch64-pc-windows-msvc.exe",
    "734bef4ea59ade8455fa798c62f8699245a45d3a80df48b0e711e3c2b86b4aba",
  ],
  "win32-x64": [
    "codex-code-mode-host-x86_64-pc-windows-msvc.exe",
    "88c55dcd4f4a0b8767991bceb5bdb8d05f72c53643714694925f33a11ced646f",
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
