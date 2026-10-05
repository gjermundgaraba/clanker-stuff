import { describe, expect, it, vi } from "vite-plus/test";
import { createPromptQueue } from "../prompts.js";

describe("questionnaire prompt queue", () => {
  it("shows one prompt at a time in request order", async () => {
    const prompt = createPromptQueue();
    const first = Promise.withResolvers<string>();
    const second = vi.fn(async () => "second");
    const signal = new AbortController().signal;

    const shown = prompt(signal, () => first.promise);
    const waiting = prompt(signal, second);
    await Promise.resolve();
    expect(second).not.toHaveBeenCalled();
    first.resolve("first");

    await expect(shown).resolves.toBe("first");
    await expect(waiting).resolves.toBe("second");
  });
  it("stops a waiting prompt on abort without letting later prompts overtake the open one", async () => {
    const prompt = createPromptQueue();
    const open = Promise.withResolvers<void>();
    const abandoned = new AbortController();
    const skipped = vi.fn(async () => {});
    const later = vi.fn(async () => {});
    const signal = new AbortController().signal;

    const shown = prompt(signal, () => open.promise);
    const waiting = prompt(abandoned.signal, skipped);
    const next = prompt(signal, later);
    abandoned.abort(new Error("stopped"));

    await expect(waiting).rejects.toThrow("stopped");
    expect(skipped).not.toHaveBeenCalled();
    expect(later).not.toHaveBeenCalled();
    open.resolve();
    await shown;
    await next;
    expect(later).toHaveBeenCalledOnce();
  });
});
