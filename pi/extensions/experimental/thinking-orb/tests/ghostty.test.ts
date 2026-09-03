import { homedir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ORB_SHADER_BASENAME,
  expandGhosttyPath,
  parseGhosttySettings,
  probeOrbEnvironment,
} from "../ghostty.js";

const ghosttyEnv = {
  TERM_PROGRAM: "Ghostty",
} as NodeJS.ProcessEnv;

const readyConfig = `
font-size = 13
custom-shader = /shaders/${ORB_SHADER_BASENAME}
custom-shader-animation = false
`;

describe(parseGhosttySettings, () => {
  it("extracts the overlay-relevant settings", () => {
    const settings = parseGhosttySettings(`
# a comment
font-size = 13.5
window-padding-x = 4
window-padding-y = 0
custom-shader = ~/shaders/${ORB_SHADER_BASENAME} # trailing comment
custom-shader-animation = false
`);
    expect(settings.fontSizePt).toBe(13.5);
    expect(settings.paddingXPt).toBe(4);
    expect(settings.paddingYPt).toBe(0);
    expect(settings.customShaderPath).toBe(`~/shaders/${ORB_SHADER_BASENAME}`);
    expect(settings.customShaderAnimation).toBeFalsy();
  });

  it("defaults animation to on and padding to two points", () => {
    const settings = parseGhosttySettings("font-size = 13");
    expect(settings.customShaderAnimation).toBeTruthy();
    expect(settings.paddingXPt).toBe(2);
    expect(settings.paddingYPt).toBe(2);
    expect(settings.customShaderPath).toBeUndefined();
  });
});

describe(expandGhosttyPath, () => {
  it("expands a leading tilde", () => {
    expect(expandGhosttyPath("~/shaders/x.glsl")).toBe(
      path.join(homedir(), "shaders/x.glsl")
    );
    expect(expandGhosttyPath("/absolute/x.glsl")).toBe("/absolute/x.glsl");
  });
});

describe(probeOrbEnvironment, () => {
  const probe = (overrides: {
    config?: string;
    env?: NodeJS.ProcessEnv;
    cellWidthPx?: number;
    backingScaleOverride?: number;
    failing?: boolean;
  }) =>
    probeOrbEnvironment({
      backingScaleOverride: overrides.backingScaleOverride,
      cellWidthPx: overrides.cellWidthPx ?? 16,
      env: { ...ghosttyEnv, ...overrides.env },
      platform: "darwin",
      showConfig: () => {
        if (overrides.failing) {
          throw new Error("boom");
        }
        return overrides.config ?? readyConfig;
      },
    });

  it("requires Ghostty", () => {
    const result = probe({ env: { TERM_PROGRAM: "Apple_Terminal" } });
    expect(result.kind).toBe("unsupported");
    expect(result.kind === "unsupported" && result.reason).toContain(
      "requires Ghostty"
    );
  });

  it("rejects multiplexers and SSH", () => {
    for (const env of [
      { TMUX: "1" },
      { STY: "1" },
      { SSH_TTY: "/dev/pts/0" },
    ]) {
      const result = probe({ env });
      expect(result.kind).toBe("unsupported");
    }
  });

  it("reports show-config failures", () => {
    const result = probe({ failing: true });
    expect(result.kind).toBe("unsupported");
    expect(result.kind === "unsupported" && result.reason).toContain(
      "ghostty +show-config"
    );
  });

  it("guides the user to /orb-setup when no shader is configured", () => {
    const result = probe({ config: "font-size = 13" });
    expect(result.kind).toBe("unsupported");
    expect(result.kind === "unsupported" && result.guidance).toContain(
      "/orb-setup"
    );
  });

  it("rejects a custom-shader that is not the orb shader", () => {
    const result = probe({
      config: `custom-shader = /shaders/crt.glsl\ncustom-shader-animation = false`,
    });
    expect(result.kind).toBe("unsupported");
    expect(result.kind === "unsupported" && result.reason).toContain(
      ORB_SHADER_BASENAME
    );
  });

  it("requires custom-shader-animation = false", () => {
    const result = probe({
      config: `custom-shader = /shaders/${ORB_SHADER_BASENAME}`,
    });
    expect(result.kind).toBe("unsupported");
    expect(result.kind === "unsupported" && result.guidance).toContain(
      "custom-shader-animation = false"
    );
  });

  it("reports a resolved environment when everything matches", () => {
    const result = probe({});
    expect(result).toStrictEqual({
      backingScale: 2,
      kind: "ready",
      settings: {
        customShaderAnimation: false,
        customShaderPath: `/shaders/${ORB_SHADER_BASENAME}`,
        fontSizePt: 13,
        paddingXPt: 2,
        paddingYPt: 2,
      },
    });
  });

  it("rejects ambiguous backing scale with non-zero padding", () => {
    const result = probe({
      config: readyConfig.replace("font-size = 13\n", ""),
    });
    expect(result.kind).toBe("unsupported");
    expect(result.kind === "unsupported" && result.reason).toContain(
      "backing scale"
    );
  });

  it("accepts an explicit backing scale override with padding", () => {
    const result = probe({
      backingScaleOverride: 2,
      config: readyConfig.replace("font-size = 13\n", ""),
    });
    expect(result.kind).toBe("ready");
  });
});
