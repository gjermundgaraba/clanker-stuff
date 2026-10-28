import {
  createEventBus,
  parseSkillBlock,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import {
  collectSkillProviders,
  SKILL_PROVIDER_CHANNEL,
  skillBlock,
} from "../index.js";
import type { LoadedSkill, ProvidedSkill, SkillProvider } from "../index.js";

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
      '<skill name="alpha" location="/skills/alpha/SKILL.md">\nReferences are relative to /skills/alpha.\n\nAlpha instructions.\n</skill>'
    );
    expect(skillBlock([alpha, beta])).toBe(
      '<skill name="alpha, beta" location="/skills/alpha/SKILL.md, /skills/beta/SKILL.md">\n## alpha\n\nReferences are relative to /skills/alpha.\n\nAlpha instructions.\n\n## beta\n\nReferences are relative to /skills/beta.\n\nBeta instructions.\n</skill>'
    );
    expect(
      parseSkillBlock(`${skillBlock([alpha, beta])}\n\nUse $alpha and $beta`)
    ).toMatchObject({
      name: "alpha, beta",
      userMessage: "Use $alpha and $beta",
    });
  });

  it("keeps blocks Pi can parse when a name or location holds a double quote", () => {
    const quoted = {
      ...beta,
      location: '/skills/"beta"/SKILL.md',
      name: 'be"ta',
    };

    expect(
      parseSkillBlock(`${skillBlock([alpha, quoted])}\n\nUse them`)
    ).toMatchObject({
      location: "/skills/alpha/SKILL.md, /skills/%22beta%22/SKILL.md",
      name: "alpha, be%22ta",
      userMessage: "Use them",
    });
  });
});

const provided = ({ content, location }: LoadedSkill): ProvidedSkill => ({
  content,
  location,
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
        return this.available.map((skill) => ({
          name: skill.name,
          description: skill.content,
        }));
      },
      async load(name: string) {
        return (
          this.available.find((skill) => skill.name === name) ?? {
            error: "not found",
          }
        );
      },
    } satisfies SkillProvider & { available: LoadedSkill[] };

    events.emit(SKILL_PROVIDER_CHANNEL, provider);
    provider.available = [beta];

    expect(providers.get("test")?.skills()).toStrictEqual([
      { name: beta.name, description: beta.content },
    ]);
    await expect(
      providers.get("test")?.load("beta", ctx)
    ).resolves.toStrictEqual(provided(beta));
    await expect(
      providers.get("test")?.load("alpha", ctx)
    ).resolves.toStrictEqual({
      error: "not found",
    });

    events.emit(SKILL_PROVIDER_CHANNEL, { ...provider, available: [alpha] });
    events.emit(SKILL_PROVIDER_CHANNEL, { id: "test", skills: [], load: null });

    expect(providers.size).toBe(1);
    await expect(
      providers.get("test")?.load("alpha", ctx)
    ).resolves.toStrictEqual(provided(alpha));
  });

  it.each([
    null,
    undefined,
    "not an object",
    { name: "alpha", location: alpha.location },
    { ...alpha, content: 42 },
    { ...alpha, location: "" },
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

    await expect(
      providers.get("test")?.load("alpha", ctx)
    ).resolves.toStrictEqual({
      error: "the provider returned invalid skill content",
    });
  });

  it.each([
    null,
    "not a list",
    [{ name: "alpha" }],
    [{ name: "alpha", description: 42 }],
    [{ name: "alpha", description: "ok" }, "beta"],
  ])("lists no skills from a malformed skills() result: %j", (listed) => {
    const events = createEventBus();
    const providers = collectSkillProviders(events);

    events.emit(SKILL_PROVIDER_CHANNEL, {
      id: "test",
      skills: () => listed,
      load: async () => ({ error: "unused" }),
    });

    expect(providers.get("test")?.skills()).toStrictEqual([]);
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

        if (name === "offline") {
          throw failure;
        }

        if (name === "denied") {
          return { error: "not approved" };
        }

        return { ...provided(alpha), content: "" };
      },
    };

    events.emit(SKILL_PROVIDER_CHANNEL, provider);

    await expect(
      providers.get("test")?.load("alpha", ctx)
    ).resolves.toStrictEqual({
      ...provided(alpha),
      content: "",
    });
    await expect(
      providers.get("test")?.load("denied", ctx)
    ).resolves.toStrictEqual({
      error: "not approved",
    });
    await expect(providers.get("test")?.load("offline", ctx)).rejects.toBe(
      failure
    );
  });
});
