import { initTheme } from "@earendil-works/pi-coding-agent";
import { Container, Text, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { preview } from "../preview.js";

beforeAll(() => initTheme("dark"));

describe("tool preview", () => {
  it("does not inspect discarded rows during the width-guard pass", () => {
    for (const edge of ["head", "tail"] as const) {
      const rows = Array.from({ length: 10000 }, () => "row");
      Object.defineProperty(rows, edge === "head" ? 9999 : 0, {
        get() {
          throw new Error("Discarded row was inspected");
        },
      });
      const component = preview(() => ({ invalidate() {}, render: () => rows }), false, 5, edge);
      expect(component.render(80)).toHaveLength(6);
      expect(component.render(40)).toHaveLength(6);
      component.invalidate();
      expect(component.render(40)).toHaveLength(6);
    }
  });
  it("clips heads and tails with the hint beside the omitted rows", () => {
    const create = () => new Text("one\ntwo\nthree\nfour", 0, 0);
    const head = preview(create, false, 2)
      .render(80)
      .map((row) => row.trimEnd());
    const tail = preview(create, false, 2, "tail")
      .render(80)
      .map((row) => row.trimEnd());
    expect(head.slice(0, 2)).toEqual(["one", "two"]);
    expect(head[2]).toContain("2 more lines");
    expect(head[2]).toContain("to expand");
    expect(tail.slice(1)).toEqual(["three", "four"]);
    expect(tail[0]).toContain("2 earlier lines");
  });
  it("shows every expanded row and does not hint when the content fits", () => {
    const create = () => new Text("one\ntwo\nthree", 0, 0);
    expect(preview(create, true, 1).render(80)).toHaveLength(3);
    expect(preview(create, false, 3).render(80)).toHaveLength(3);
    expect(preview(create, false, 3).render(80).join("\n")).not.toContain("to expand");
  });
  it("bounds visual rows, including long lines and multicolumn text", () => {
    const component = preview(() => new Text("中文 " + "word ".repeat(100), 0, 0), false, 3);
    for (const width of [1, 2, 20, 80]) {
      const rows = component.render(width);
      expect(rows).toHaveLength(4);
      expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
    }
  });
  it("caches by width and recreates themed component trees after invalidation", () => {
    let color = "\x1b[31m";
    let creations = 0;
    let renders = 0;
    const component = preview(() => {
      creations++;
      const container = new Container();
      container.addChild(new Text(`${color}hello\x1b[0m`, 0, 0));
      return {
        invalidate: () => container.invalidate(),
        render(width) {
          renders++;
          return container.render(width);
        },
      };
    }, false);
    const first = component.render(80);
    expect(component.render(80)).toBe(first);
    expect(renders).toBe(1);
    component.render(20);
    expect(renders).toBe(2);
    expect(creations).toBe(1);
    color = "\x1b[32m";
    component.invalidate();
    expect(component.render(20).join("\n")).toContain("\x1b[32mhello");
    expect(creations).toBe(2);
  });
});
