import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  forgetSessionCwd,
  rememberSessionCwd,
  rememberSummarySession,
  sessionCwdFor,
  summarySessionFor,
} from "../../session/cwd.js";

describe("session cwd", () => {
  afterEach(() => {
    for (const id of ["s1", "s2", "s3"]) forgetSessionCwd(id);
  });

  it("returns the remembered cwd for its session only", () => {
    rememberSessionCwd("s1", "/agents/Martin");

    expect(sessionCwdFor("s1")).toBe("/agents/Martin");
    expect(sessionCwdFor("other")).toBe(process.cwd());
  });

  it("falls back to process.cwd() for null and undefined", () => {
    expect(sessionCwdFor(null)).toBe(process.cwd());
    expect(sessionCwdFor(undefined)).toBe(process.cwd());
  });

  it("forgets an entry", () => {
    rememberSessionCwd("s2", "/x");
    forgetSessionCwd("s2");

    expect(sessionCwdFor("s2")).toBe(process.cwd());
  });

  // A subagent host can load the extension fresh for a child session while the first
  // evaluation keeps serving provider traffic, so the store must outlive the module.
  it("shares the store with a fresh evaluation of the module", async () => {
    vi.resetModules();

    const fresh = await import("../../session/cwd.js");

    expect(fresh.sessionCwdFor).not.toBe(sessionCwdFor);

    rememberSessionCwd("s3", "/shared");

    expect(fresh.sessionCwdFor("s3")).toBe("/shared");
  });
});

describe("summary sessions", () => {
  it("maps a summary operation's signal to the session that started it", () => {
    const signal = new AbortController().signal;

    rememberSummarySession(signal, "s-compact");

    expect(summarySessionFor(signal)).toBe("s-compact");
    expect(summarySessionFor(new AbortController().signal)).toBeUndefined();
    expect(summarySessionFor(undefined)).toBeUndefined();
  });
});
