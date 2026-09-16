import { Box, Text } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vite-plus/test";

import { cachedBox, cachedLines, lazyComponent } from "../../tools/render-components.js";

describe("render component lifecycle", () => {
  it("caches a composed box and refreshes on resize or invalidation", () => {
    const text = new Text("before", 0, 0);
    const render = vi.spyOn(text, "render");
    const invalidate = vi.spyOn(text, "invalidate");
    const box = new Box(1, 1);
    box.addChild(text);
    const component = cachedBox(box);
    const first = component.render(80);
    expect(component.render(80)).toBe(first);
    expect(render).toHaveBeenCalledTimes(1);
    component.render(40);
    expect(render).toHaveBeenCalledTimes(2);
    text.setText("after");
    component.invalidate();
    expect(invalidate).toHaveBeenCalledTimes(1);
    const after = component.render(40);
    expect(after.join("\n")).toContain("after");
    expect(component.render(40)).toBe(after);
    expect(render).toHaveBeenCalledTimes(3);
  });

  it("retains only the last width and forwards invalidation", () => {
    const draw = vi.fn((width: number) => [String(width)]);
    const invalidate = vi.fn();
    const component = cachedLines(draw, invalidate);
    const first = component.render(80);
    expect(component.render(80)).toBe(first);
    expect(draw).toHaveBeenCalledTimes(1);
    component.render(40);
    component.render(80);
    expect(draw).toHaveBeenCalledTimes(3);
    component.invalidate();
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(component.render(80)).toEqual(first);
    expect(draw).toHaveBeenCalledTimes(4);
  });

  it("prepares a lazy child once, retains it across resizes, and rebuilds on invalidation", () => {
    let content = "pending";
    const create = vi.fn(() => new Text(content, 0, 0));
    const component = lazyComponent(create);
    expect(create).not.toHaveBeenCalled();
    content = "completed";
    expect(component.render(80)[0]?.trim()).toBe("completed");
    component.render(80);
    component.render(40);
    expect(create).toHaveBeenCalledTimes(1);
    content = "changed";
    component.invalidate();
    expect(component.render(40)[0]?.trim()).toBe("changed");
    expect(create).toHaveBeenCalledTimes(2);
  });
});
