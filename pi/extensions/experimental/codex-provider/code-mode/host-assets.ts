// Asset names and SHA-256 digests from the official OpenAI Codex release API.
// Keep current using docs/codex-baseline.md#code-mode-host-upkeep.
export const HOST_RELEASE = "rust-v0.155.0";

interface HostAssetIndex {
  [key: string]: readonly [string, string] | undefined;
}

export const HOST_ASSETS: HostAssetIndex = {
  "darwin-arm64": [
    "codex-code-mode-host-aarch64-apple-darwin.tar.gz",
    "3d751deef91b4526f086029c9395feb872abf7a717e45752ad1b33dcb387fa6b",
  ],
  "darwin-x64": [
    "codex-code-mode-host-x86_64-apple-darwin.tar.gz",
    "285d1c6fdacf9b500fe041c0a98b06cf58eb7ea35549554bcb2a0c04866ef49d",
  ],
  "linux-arm64": [
    "codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz",
    "0ecd8e263468b520770c6dc6c9ebafeba3052c0c9796eabc5b0c469f77d5489b",
  ],
  "linux-x64": [
    "codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz",
    "328c1bebe09fc727053794576efea353d3b18381ee8883f5283b37ae4a7854d4",
  ],
  "win32-arm64": [
    "codex-code-mode-host-aarch64-pc-windows-msvc.exe",
    "600cd4465b0508e3731235cd1b00b06f67512fde7f4376a2331aae431927c097",
  ],
  "win32-x64": [
    "codex-code-mode-host-x86_64-pc-windows-msvc.exe",
    "1d0569ec6390b4f446ecc7cd66ec7e5103648d55e065d45dbca19120d0bbd056",
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
