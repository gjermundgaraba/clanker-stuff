import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { frame, FPS, INKS, paint, VIEWBOX } from "../scripts/frames.ts";
import { geometry, project, SHAPES, TAU } from "../scripts/geometry.ts";

// SAFETY: Frozen numeric outputs from the independent extracted audit oracle.
const fixtures = JSON.parse(
  readFileSync(new URL("./fixtures/projections.json", import.meta.url), "utf8"),
) as {
  shape: string;
  seed: string;
  yaw: number;
  weight: number;
  lines: { id: number; depth: number; outline: number; opacity: number; points: number[] }[];
}[];

describe("reconstructed geometry", () => {
  it("matches independent projected coordinates, depth, silhouettes and whole-path opacity", () => {
    for (const fixture of fixtures) {
      const actual = project(geometry(fixture.seed, fixture.shape), fixture.yaw, fixture.weight);
      expect(actual).toHaveLength(fixture.lines.length);
      for (const expected of fixture.lines) {
        const line = actual.find((candidate) => candidate.id === expected.id);
        if (!line) throw new Error("Missing projected path");
        expect(line.depth).toBeCloseTo(expected.depth, 10);
        expect(line.opacity).toBeCloseTo(expected.opacity, 10);
        expect(line.outline).toBeCloseTo(expected.outline, 10);
        const xy = line.points.flatMap((point) => point.slice(0, 2));
        expect(xy).toHaveLength(expected.points.length);
        xy.forEach((value, i) => expect(value).toBeCloseTo(expected.points[i], 10));
      }
    }
  });

  it("keeps source inks in sync with the shipped palette", () => {
    const metadata = JSON.parse(
      readFileSync(new URL("../assets/shapes.json", import.meta.url), "utf8"),
    );
    expect(INKS).toEqual(metadata.inks);
  });

  it("keeps native compact radii and 16 six-point orb paths", () => {
    const orb = geometry("amp-orb", "orb");
    expect(orb.radius).toBeCloseTo(10.925, 10);
    expect(orb.strokeWidth).toBe(1.2);
    expect(orb.vertices).toHaveLength(80);
    expect(orb.lines).toHaveLength(16);
    expect(new Set(orb.lines.map((line) => line.length))).toEqual(new Set([6]));
    expect(orb.lines[3]).toEqual([15, 16, 17, 18, 19, 0]);
    expect(geometry("amp-orb", "cube").lines).toHaveLength(12);
    expect(geometry("amp-orb", "octahedron").lines).toHaveLength(12);
    expect(geometry("amp-orb", "tetrahedron").lines).toHaveLength(6);
    expect(() => geometry("seed", "sphere")).toThrow("Unknown shape");
  });

  it("closes the full rotation, keeps rest distinct, and never clips the fixed viewport", () => {
    for (const shape of SHAPES) {
      const g = geometry("amp-orb", shape);
      const start = project(g, 0, 0);
      for (const line of project(g, TAU, 0)) {
        const first = start.find((candidate) => candidate.id === line.id);
        if (!first) throw new Error("Missing seam path");
        line.points.forEach((point, i) =>
          point.forEach((value, j) => expect(value).toBeCloseTo(first.points[i][j], 10)),
        );
        expect(line.opacity).toBeCloseTo(first.opacity, 10);
      }
      expect(frame(shape, 0).lines).not.toEqual(frame(shape, 1).lines);
      expect(frame(shape, 0, true).lines).not.toEqual(frame(shape, 0).lines);
      for (let i = 0; i < FPS * 8; i++) {
        const scene = frame(shape, i / FPS);
        const radius = scene.strokeWidth / 2;
        scene.lines.forEach((line, index) => {
          if (index) expect(line.depth).toBeGreaterThanOrEqual(scene.lines[index - 1].depth);
          expect(line.opacity).toBeGreaterThanOrEqual(0.16);
          expect(line.opacity).toBeLessThanOrEqual(1);
          for (const point of line.points)
            for (const value of point.slice(0, 2)) {
              const position = VIEWBOX / 2 + (value - 12);
              expect(position - radius).toBeGreaterThan(0);
              expect(position + radius).toBeLessThan(VIEWBOX);
            }
        });
      }
    }
  });

  it.each(["cube", "octahedron", "tetrahedron"])("does not seed %s geometry", (shape) => {
    expect(geometry("amp-orb", shape)).toEqual(geometry("😀", shape));
  });

  it("strokes whole paths with depth opacity at the fixed viewport scale", () => {
    const strokes: number[] = [],
      transforms: number[][] = [];
    let segments = 0;
    const context = {
      globalAlpha: 1,
      lineCap: "",
      lineJoin: "",
      lineWidth: 0,
      strokeStyle: "",
      setTransform: (...args: number[]) => transforms.push(args),
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {
        segments++;
      },
      stroke: () => strokes.push(context.globalAlpha),
    };
    const canvas = { width: 0, height: 0, getContext: () => context };
    const scene = frame("orb", 1);
    paint(canvas, scene, 64, "#fff", VIEWBOX);
    expect(strokes).toEqual(scene.lines.map((line) => line.opacity));
    expect(segments).toBe(80);
    expect(context.lineCap).toBe("round");
    expect(context.lineJoin).toBe("round");
    expect(transforms[0][0]).toBeCloseTo(64 / VIEWBOX);
    expect(context.lineWidth).toBe(1.2);
    expect(canvas.width).toBe(64);
  });
});
