// Asset names and SHA-256 digests from the official OpenAI Codex release API.
// Keep current using docs/codex-baseline.md#code-mode-host-upkeep.
export const HOST_RELEASE = "rust-v0.153.4";

interface HostAssetIndex {
  [key: string]: readonly [string, string] | undefined;
}

export const HOST_ASSETS: HostAssetIndex = {
  "darwin-arm64": [
    "codex-code-mode-host-aarch64-apple-darwin.tar.gz",
    "45a9b0fdf53b98b85a6bb91e175dd90e961328a7a14fb50a40902205199df1df",
  ],
  "darwin-x64": [
    "codex-code-mode-host-x86_64-apple-darwin.tar.gz",
    "2ffaebd0103d976232c358419a508859da862e128f3ca0bb071541346fbe3bf7",
  ],
  "linux-arm64": [
    "codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz",
    "d8047b8d33370d6090e729d27eb76de60a2686baa1c143c138c9b05dc70d813b",
  ],
  "linux-x64": [
    "codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz",
    "f95830a869590957664bbfc67bccb08773806b693670baf15908176f89b4cd31",
  ],
  "win32-arm64": [
    "codex-code-mode-host-aarch64-pc-windows-msvc.exe",
    "5143bbc28a1cddbfc9d51327159e4df6f2f8ceff1faa20359ba7d83226033e0f",
  ],
  "win32-x64": [
    "codex-code-mode-host-x86_64-pc-windows-msvc.exe",
    "deaebc21f354f151fcebeac46e12c6e8c4ef75ee448e25e3577502074e04b8d9",
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
