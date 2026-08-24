import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";

import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

const DEFAULT_CODEX_APP_PATH = "/Applications/ChatGPT.app";
const DEFAULT_BUNDLE_IDENTIFIER = "com.openai.codex";
const ATTESTATION_TOKEN_VERSION = "v1";
const PROCESS_APP_SESSION_ID = randomUUID();
const requireNative = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
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
let defaultSignalsPromise: Promise<DeviceAttestationSignals> | undefined;

interface DeviceCheckResult {
  supported?: boolean;
  tokenBase64: string;
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
  options: CodexDesktopAttestationOptions = {},
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== "darwin" || arch !== "arm64") {
    throw new Error(
      `Codex Desktop DeviceCheck attestation requires macOS arm64; received ${platform} ${arch}.`,
    );
  }

  const appPath = options.codexAppPath ?? DEFAULT_CODEX_APP_PATH;
  const addonPath =
    options.addonPath ?? path.join(appPath, "Contents", "Resources", "native", "devicecheck.node");

  let addon: DeviceCheckAddon;
  try {
    addon = (options.loadAddon ?? loadDeviceCheckAddon)(addonPath);
  } catch (error) {
    throw new Error(
      `Could not load Codex Desktop DeviceCheck from ${addonPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  let result: DeviceCheckResult;
  const startedAt = performance.now();
  try {
    result = await addon.generateToken();
  } catch (error) {
    throw new Error(
      `Codex Desktop DeviceCheck token generation failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (result.supported !== true) {
    throw new Error("Codex Desktop DeviceCheck reported that attestation is unavailable.");
  }
  if (result.tokenBase64.trim().length === 0) {
    throw new Error("Codex Desktop DeviceCheck returned no token.");
  }

  const latencyMs =
    result.latencyMs !== undefined && Number.isFinite(result.latencyMs) && result.latencyMs >= 0
      ? result.latencyMs
      : Math.max(0, performance.now() - startedAt);
  const token = buildCodexDesktopAttestationToken({
    bundleIdentifier: options.bundleIdentifier ?? DEFAULT_BUNDLE_IDENTIFIER,
    latencyMs,
    nativeToken: result.tokenBase64,
    signals: options.signals ?? (await defaultSignals()),
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
  return `${ATTESTATION_TOKEN_VERSION}.${Buffer.concat([cborLength(5, fields.length), ...fields]).toString("base64url")}`;
}

function loadDeviceCheckAddon(addonPath: string): DeviceCheckAddon {
  return requireNative(addonPath);
}

const MacosSignalsSchema = Type.Object({
  height: Type.Optional(Type.Number()),
  languages: Type.Optional(Type.Array(Type.String())),
  locale: Type.Optional(Type.String()),
  scale: Type.Optional(Type.Number()),
  timezone: Type.Optional(Type.String()),
  width: Type.Optional(Type.Number()),
});

type MacosSignals = Static<typeof MacosSignalsSchema>;

async function resolveDefaultSignals(): Promise<DeviceAttestationSignals> {
  const resolved = Intl.DateTimeFormat().resolvedOptions();
  const fallbackLocale = boundedText(resolved.locale.length > 0 ? resolved.locale : "unknown", 64);
  let macos: MacosSignals = {};
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", MACOS_SIGNALS_SCRIPT],
      { encoding: "utf-8", timeout: 2000 },
    );
    const parsed: unknown = JSON.parse(stdout);
    if (Value.Check(MacosSignalsSchema, parsed)) {
      macos = Value.Parse(MacosSignalsSchema, parsed);
    }
  } catch {
    // Fall back to Node's locale and timezone signals.
  }
  const locale =
    macos.locale !== undefined
      ? boundedText(macos.locale.split("@", 1)[0]?.replaceAll("_", "-") ?? fallbackLocale, 64)
      : fallbackLocale;
  const languages = macos.languages ?? [];
  const width = finiteNonNegative(macos.width);
  const height = finiteNonNegative(macos.height);
  const scale = finiteNonNegative(macos.scale);
  const timezone = macos.timezone !== undefined ? macos.timezone : resolved.timeZone;
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

const defaultSignals = (): Promise<DeviceAttestationSignals> => {
  defaultSignalsPromise ??= resolveDefaultSignals();
  return defaultSignalsPromise;
};

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
  return Number.isSafeInteger(value) && value >= 0 ? cborUnsigned(value) : cborFloat(value);
}

function cborUnsigned(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(
      `CBOR unsigned integer must be a non-negative safe integer; received ${value}.`,
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
    throw new Error(`CBOR length must be a non-negative safe integer; received ${value}.`);
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

function boundedText(value: string, maxLength: number): string {
  return value.slice(0, maxLength);
}

function finiteNonNegative(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : null;
}
