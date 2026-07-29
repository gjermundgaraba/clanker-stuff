/* eslint-disable complexity, func-style, no-use-before-define */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";

const DEFAULT_CODEX_APP_PATH = "/Applications/Codex.app";
const DEFAULT_BUNDLE_IDENTIFIER = "com.openai.codex";
const ATTESTATION_TOKEN_VERSION = "v1";
const PROCESS_APP_SESSION_ID = randomUUID();
const requireNative = createRequire(import.meta.url);
const MACOS_SIGNALS_SCRIPT = `
ObjC.import('AppKit')
ObjC.import('Foundation')
const screen = $.NSScreen.mainScreen
const frame = screen.frame
JSON.stringify({
  languages: ObjC.deepUnwrap($.NSLocale.preferredLanguages),
  locale: ObjC.unwrap($.NSLocale.currentLocale.localeIdentifier),
  timezone: ObjC.unwrap($.NSTimeZone.localTimeZone.name),
  width: Number(frame.size.width),
  height: Number(frame.size.height),
  scale: Number(screen.backingScaleFactor),
})
`;

interface DeviceCheckResult {
  supported?: boolean;
  tokenBase64?: string;
  latencyMs?: number;
}

interface DeviceCheckAddon {
  generateToken: () => Promise<DeviceCheckResult>;
}

export interface DeviceAttestationSignals {
  schemaVersion: number;
  preferredLanguages: string[];
  locale: string;
  timezone: string;
  screenSizeSum: number;
  screenScale: number;
  appSessionId: string;
}

export interface CodexDesktopAttestationOptions {
  codexAppPath?: string;
  addonPath?: string;
  bundleIdentifier?: string;
  signals?: DeviceAttestationSignals;
  platform?: NodeJS.Platform;
  arch?: string;
  loadAddon?: (path: string) => DeviceCheckAddon;
}

export async function createCodexDesktopAttestationHeader(
  options: CodexDesktopAttestationOptions = {}
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== "darwin" || arch !== "arm64") {
    throw new Error(
      `Codex Desktop DeviceCheck attestation requires macOS arm64; received ${platform} ${arch}.`
    );
  }

  const appPath = options.codexAppPath ?? DEFAULT_CODEX_APP_PATH;
  const addonPath =
    options.addonPath ??
    path.join(appPath, "Contents", "Resources", "native", "devicecheck.node");

  let addon: unknown;
  try {
    addon = (options.loadAddon ?? loadDeviceCheckAddon)(addonPath);
  } catch (error) {
    throw new Error(
      `Could not load Codex Desktop DeviceCheck from ${addonPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  if (!isDeviceCheckAddon(addon)) {
    throw new Error(
      `Codex Desktop DeviceCheck at ${addonPath} does not export generateToken().`
    );
  }

  let result: DeviceCheckResult;
  const startedAt = performance.now();
  try {
    result = await addon.generateToken();
  } catch (error) {
    throw new Error(
      `Codex Desktop DeviceCheck token generation failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  if (result.supported !== true) {
    throw new Error(
      "Codex Desktop DeviceCheck reported that attestation is unavailable."
    );
  }
  if (
    typeof result.tokenBase64 !== "string" ||
    result.tokenBase64.trim().length === 0
  ) {
    throw new Error("Codex Desktop DeviceCheck returned no token.");
  }

  const latencyMs =
    Number.isFinite(result.latencyMs) && Number(result.latencyMs) >= 0
      ? Number(result.latencyMs)
      : Math.max(0, performance.now() - startedAt);
  const token = buildCodexDesktopAttestationToken({
    bundleIdentifier: options.bundleIdentifier ?? DEFAULT_BUNDLE_IDENTIFIER,
    latencyMs,
    nativeToken: result.tokenBase64,
    signals: options.signals ?? defaultSignals(),
  });
  return JSON.stringify({ s: 0, t: token, v: 1 });
}

export function buildCodexDesktopAttestationToken(input: {
  nativeToken: string;
  bundleIdentifier: string;
  signals: DeviceAttestationSignals;
  latencyMs: number;
}): string {
  const encodedSignals = cborSignals(input.signals);
  const fields = [
    cborTextPair("token", input.nativeToken),
    cborTextPair("bundle_id", input.bundleIdentifier),
    Buffer.concat([cborText("f"), cborBytes(encodedSignals)]),
    Buffer.concat([cborText("t"), cborFloat(input.latencyMs)]),
  ];
  return `${ATTESTATION_TOKEN_VERSION}.${base64Url(Buffer.concat([cborLength(5, fields.length), ...fields]))}`;
}

function loadDeviceCheckAddon(addonPath: string): DeviceCheckAddon {
  const addon: unknown = requireNative(addonPath);
  if (!isDeviceCheckAddon(addon)) {
    throw new Error("The DeviceCheck module does not export generateToken().");
  }
  return addon;
}

function defaultSignals(): DeviceAttestationSignals {
  const resolved = Intl.DateTimeFormat().resolvedOptions();
  const fallbackLocale = boundedText(
    resolved.locale.length > 0 ? resolved.locale : "unknown",
    64
  );
  let macos: {
    languages?: unknown;
    locale?: unknown;
    timezone?: unknown;
    width?: unknown;
    height?: unknown;
    scale?: unknown;
  } = {};
  try {
    const parsed: unknown = JSON.parse(
      execFileSync(
        "/usr/bin/osascript",
        ["-l", "JavaScript", "-e", MACOS_SIGNALS_SCRIPT],
        { encoding: "utf-8", timeout: 2000 }
      )
    );
    if (isRecord(parsed)) {
      macos = parsed;
    }
  } catch {
    // Fall back to Node's locale and timezone signals.
  }
  const locale =
    typeof macos.locale === "string"
      ? boundedText(
          macos.locale.split("@", 1)[0]?.replaceAll("_", "-") ?? fallbackLocale,
          64
        )
      : fallbackLocale;
  const languages = Array.isArray(macos.languages)
    ? macos.languages.filter(
        (value): value is string => typeof value === "string"
      )
    : [];
  const width = finiteNonNegative(macos.width);
  const height = finiteNonNegative(macos.height);
  const scale = finiteNonNegative(macos.scale);
  const timezone =
    typeof macos.timezone === "string" ? macos.timezone : resolved.timeZone;
  return {
    appSessionId: PROCESS_APP_SESSION_ID,
    locale,
    preferredLanguages: (languages.length > 0 ? languages : [locale])
      .slice(0, 16)
      .map((language) => boundedText(language, 64)),
    schemaVersion: 1,
    screenScale: scale ?? 1,
    screenSizeSum: Math.max(0, Math.round((width ?? 0) + (height ?? 0))),
    timezone: boundedText(timezone.length > 0 ? timezone : "unknown", 64),
  };
}

function cborSignals(signals: DeviceAttestationSignals): Buffer {
  const fields = [
    cborIntegerPair(0, signals.schemaVersion),
    Buffer.concat([
      cborUnsigned(1),
      cborLength(4, signals.preferredLanguages.length),
      ...signals.preferredLanguages.map((language) => cborText(language)),
    ]),
    Buffer.concat([cborUnsigned(2), cborText(signals.locale)]),
    Buffer.concat([cborUnsigned(3), cborText(signals.timezone)]),
    cborIntegerPair(4, signals.screenSizeSum),
    Buffer.concat([cborUnsigned(5), cborNumber(signals.screenScale)]),
    Buffer.concat([cborUnsigned(6), cborText(signals.appSessionId)]),
  ];
  return Buffer.concat([cborLength(5, fields.length), ...fields]);
}

function cborTextPair(key: string, value: string): Buffer {
  return Buffer.concat([cborText(key), cborText(value)]);
}

function cborBytes(value: Buffer): Buffer {
  return Buffer.concat([cborLength(2, value.length), value]);
}

function cborIntegerPair(key: number, value: number): Buffer {
  return Buffer.concat([cborUnsigned(key), cborUnsigned(value)]);
}

function cborNumber(value: number): Buffer {
  return Number.isSafeInteger(value) && value >= 0
    ? cborUnsigned(value)
    : cborFloat(value);
}

function cborUnsigned(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(
      `CBOR unsigned integer must be a non-negative safe integer; received ${value}.`
    );
  }
  return cborLength(0, value);
}

function cborFloat(value: number): Buffer {
  if (!Number.isFinite(value)) {
    throw new TypeError(`CBOR float must be finite; received ${value}.`);
  }
  const encoded = Buffer.allocUnsafe(9);
  encoded[0] = 0xfb;
  encoded.writeDoubleBE(value, 1);
  return encoded;
}

function cborText(value: string): Buffer {
  const encoded = Buffer.from(value, "utf-8");
  return Buffer.concat([cborLength(3, encoded.length), encoded]);
}

function cborLength(majorType: number, value: number): Buffer {
  const prefix = majorType * 32;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `CBOR length must be a non-negative safe integer; received ${value}.`
    );
  }
  if (value < 24) {
    return Buffer.from([prefix + value]);
  }
  if (value <= 0xff) {
    return Buffer.from([prefix + 24, value]);
  }
  if (value <= 0xff_ff) {
    const encoded = Buffer.allocUnsafe(3);
    encoded[0] = prefix + 25;
    encoded.writeUInt16BE(value, 1);
    return encoded;
  }
  if (value <= 0xff_ff_ff_ff) {
    const encoded = Buffer.allocUnsafe(5);
    encoded[0] = prefix + 26;
    encoded.writeUInt32BE(value, 1);
    return encoded;
  }
  throw new Error(`CBOR value is too large: ${value}.`);
}

function base64Url(value: Buffer): string {
  return value
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function boundedText(value: string, maxLength: number): string {
  return value.slice(0, maxLength);
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function isDeviceCheckAddon(value: unknown): value is DeviceCheckAddon {
  return (
    value !== null &&
    typeof value === "object" &&
    "generateToken" in value &&
    typeof value.generateToken === "function"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
