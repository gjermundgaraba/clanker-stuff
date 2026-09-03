/**
 * Ghostty environment probing: parses `ghostty +show-config`, validates the
 * overlay's requirements, and reports actionable guidance when the shader is
 * missing or misconfigured. All impure inputs are injectable for tests.
 */

import { homedir } from "node:os";
import path from "node:path";

import { detectBackingScale } from "./layout.js";

export const ORB_SHADER_BASENAME = "thinking-orb-overlay.glsl";

export interface GhosttySettings {
  /** Ghostty re-renders custom shaders on its own clock by default. */
  customShaderAnimation: boolean;
  customShaderPath?: string;
  fontSizePt?: number;
  paddingXPt: number;
  paddingYPt: number;
}

const SETTING_PATTERN = /^\s*(?<key>[a-z0-9-]+)\s*=\s*(?<value>.*?)\s*$/u;

const stripComment = (line: string): string => {
  const commentIndex = line.search(/\s#/u);
  return commentIndex === -1 ? line : line.slice(0, commentIndex);
};

const parseBoolean = (value: string, fallback: boolean): boolean => {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return fallback;
};

const parseNumber = (value: string): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

export const parseGhosttySettings = (configText: string): GhosttySettings => {
  const settings: GhosttySettings = {
    customShaderAnimation: true,
    paddingXPt: 2,
    paddingYPt: 2,
  };

  for (const line of configText.split("\n")) {
    const match = SETTING_PATTERN.exec(stripComment(line));
    if (!match?.groups) {
      continue;
    }
    const { key, value } = match.groups;
    if (key === "custom-shader") {
      settings.customShaderPath = value || undefined;
    } else if (key === "custom-shader-animation") {
      settings.customShaderAnimation = parseBoolean(value, true);
    } else if (key === "font-size") {
      settings.fontSizePt = parseNumber(value);
    } else if (key === "window-padding-x") {
      settings.paddingXPt = parseNumber(value) ?? settings.paddingXPt;
    } else if (key === "window-padding-y") {
      settings.paddingYPt = parseNumber(value) ?? settings.paddingYPt;
    }
  }

  return settings;
};

/** Expands a leading `~` the way Ghostty resolves config paths. */
export const expandGhosttyPath = (value: string): string => {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(homedir(), value.slice(2));
  }
  return value;
};

export type OrbEnvironment =
  | {
      backingScale: number;
      kind: "ready";
      settings: GhosttySettings;
    }
  | {
      guidance?: string;
      kind: "unsupported";
      reason: string;
    };

export interface OrbProbeInputs {
  backingScaleOverride?: number;
  cellWidthPx: number;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  showConfig: () => string;
}

export const probeOrbEnvironment = (inputs: OrbProbeInputs): OrbEnvironment => {
  const termProgram = inputs.env.TERM_PROGRAM?.toLowerCase();
  if (termProgram !== "ghostty") {
    return {
      kind: "unsupported",
      reason: `the Thinking Orb requires Ghostty (TERM_PROGRAM is ${
        termProgram ?? "unset"
      })`,
    };
  }

  if (
    inputs.env.TMUX !== undefined ||
    inputs.env.STY !== undefined ||
    inputs.env.SSH_TTY !== undefined
  ) {
    return {
      kind: "unsupported",
      reason:
        "the Thinking Orb cannot run inside tmux, screen, or an SSH session",
    };
  }

  let settings: GhosttySettings;
  try {
    settings = parseGhosttySettings(inputs.showConfig());
  } catch (error) {
    return {
      kind: "unsupported",
      reason: `could not read \`ghostty +show-config\`: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (settings.customShaderPath === undefined) {
    return {
      guidance: "run /orb-setup to install the shader, then restart Ghostty",
      kind: "unsupported",
      reason: "Ghostty has no custom-shader configured",
    };
  }

  const shaderPath = expandGhosttyPath(settings.customShaderPath);
  if (path.basename(shaderPath) !== ORB_SHADER_BASENAME) {
    return {
      kind: "unsupported",
      reason: `custom-shader is ${shaderPath}, expected a shader named ${ORB_SHADER_BASENAME}`,
    };
  }

  if (settings.customShaderAnimation) {
    return {
      guidance:
        "set custom-shader-animation = false in Ghostty so the heartbeat can drive the frame rate",
      kind: "unsupported",
      reason: "custom-shader-animation must be false",
    };
  }

  const backingScale = detectBackingScale({
    cellWidthPx: inputs.cellWidthPx,
    fontPt: settings.fontSizePt,
    override: inputs.backingScaleOverride,
    platform: inputs.platform,
  });
  if (
    !backingScale.confident &&
    (settings.paddingXPt > 0 || settings.paddingYPt > 0)
  ) {
    return {
      guidance:
        "set backingScale to 1, 2, or 3 in ~/.pi/agent/thinking-orb.json, or set window-padding-x and window-padding-y to 0 in Ghostty",
      kind: "unsupported",
      reason: `cannot determine the display backing scale for padding (estimated ${backingScale.scale})`,
    };
  }

  return {
    backingScale: backingScale.scale,
    kind: "ready",
    settings,
  };
};
