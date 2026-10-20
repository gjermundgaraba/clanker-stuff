import { createEventBus, parseSkillBlock } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import { collectSkillProviders, SKILL_PROVIDER_CHANNEL, skillBlock } from "../index.js";
import type { LoadedSkill, SkillProvider } from "../index.js";

const alpha: LoadedSkill = {
  content: "References are relative to /skills/alpha.\n\nAlpha instructions.",
  location: "/skills/alpha/SKILL.md",
  name: "alpha",
};

const beta: LoadedSkill = {
  content: "References are relative to /skills/beta.\n\nBeta instructions.",
  location: "/skills/beta/SKILL.md",
  name: "beta",
};

describe("skill blocks", () => {
  it("writes Pi's own block for one skill and one merged block for several", () => {
    expect(skillBlock([alpha])).toBe(
      '<skill name="alpha" location="/skills/alpha/SKILL.md">\nReferences are relative to /skills/alpha.\n\nAlpha instructions.\n</skill>',
    );
    expect(skillBlock([alpha, beta])).toBe(
      '<skill name="alpha, beta" location="/skills/alpha/SKILL.md, /skills/beta/SKILL.md">\n## alpha\n\nReferences are relative to /skills/alpha.\n\nAlpha instructions.\n\n## beta\n\nReferences are relative to /skills/beta.\n\nBeta instructions.\n</skill>',
    );
    // Pi's parser drives its collapsed rendering and must read the merged block as one.
    expect(parseSkillBlock(`${skillBlock([alpha, beta])}\n\nUse $alpha and $beta`)).toMatchObject({
      name: "alpha, beta",
      userMessage: "Use $alpha and $beta",
    });
  });
});

describe("skill providers", () => {
  it("keeps providers live, preserves method receivers, and replaces announcements by id", async () => {
    const events = createEventBus();
    const providers = collectSkillProviders(events);
    const ctx = createExtensionHost(() => {}).createContext();

    const provider = {
      id: "test",
      available: [alpha],
      skills() {
        return this.available.map((skill) => ({ name: skill.name, description: skill.content }));
      },
      async load(name: string) {
        return this.available.find((skill) => skill.name === name) ?? { error: "not found" };
      },
    } satisfies SkillProvider & { available: LoadedSkill[] };

    events.emit(SKILL_PROVIDER_CHANNEL, provider);
    provider.available = [beta];

    expect(providers.get("test")?.skills()).toStrictEqual([
      { name: beta.name, description: beta.content },
    ]);
    expect(await providers.get("test")?.load("beta", ctx)).toStrictEqual(beta);
    expect(await providers.get("test")?.load("alpha", ctx)).toStrictEqual({ error: "not found" });

    events.emit(SKILL_PROVIDER_CHANNEL, { ...provider, available: [alpha] });
    events.emit(SKILL_PROVIDER_CHANNEL, { id: "test", skills: [], load: null });

    expect(providers.size).toBe(1);
    expect(await providers.get("test")?.load("alpha", ctx)).toStrictEqual(alpha);
  });

  it.each([
    null,
    undefined,
    "not an object",
    { name: "alpha", location: alpha.location },
    { ...alpha, content: 42 },
    { ...alpha, error: 42 },
  ])("rejects malformed load results: %j", async (result) => {
    const events = createEventBus();
    const providers = collectSkillProviders(events);
    const ctx = createExtensionHost(() => {}).createContext();

    events.emit(SKILL_PROVIDER_CHANNEL, {
      id: "test",
      skills: () => [],
      load: async () => result,
    });

    expect(await providers.get("test")?.load("alpha", ctx)).toStrictEqual({
      error: "the provider returned invalid skill content",
    });
  });

  it("preserves empty content, provider errors, and thrown failures", async () => {
    const events = createEventBus();
    const providers = collectSkillProviders(events);
    const ctx = createExtensionHost(() => {}).createContext();
    const failure = new Error("offline");

    const provider: SkillProvider = {
      id: "test",
      skills: () => [],
      async load(name, context) {
        expect(context).toBe(ctx);

        if (name === "offline") throw failure;

        if (name === "denied") return { error: "not approved" };

        return { ...alpha, content: "" };
      },
    };

    events.emit(SKILL_PROVIDER_CHANNEL, provider);

    expect(await providers.get("test")?.load("alpha", ctx)).toStrictEqual({
      ...alpha,
      content: "",
    });
    expect(await providers.get("test")?.load("denied", ctx)).toStrictEqual({
      error: "not approved",
    });
    await expect(providers.get("test")?.load("offline", ctx)).rejects.toBe(failure);
  });
});
