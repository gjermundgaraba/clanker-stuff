// Real GPU shader in the terminal: WGSL scenes rendered offscreen
// with WebGPU (Dawn via bun-webgpu), read back, and blitted to half-block
// cells with 24-bit foreground/background color — the OpenTUI architecture
// with the gallery's own blitter. Targets Ghostty on this machine.
//
// Run: bun scripts/shader-terminal.ts [--scene torus|voxel] [--seconds 20]
// Non-TTY runs every scene once and reports GPU timing (self-check).

/// <reference types="@webgpu/types" />

import { once } from "node:events";

import { setupGlobals } from "bun-webgpu";

setupGlobals();

const scenes = ["torus", "voxel"] as const;
const sceneArg = process.argv.indexOf("--scene");
const scene = sceneArg < 0 ? "torus" : process.argv[sceneArg + 1];

if (process.argv.includes("--list")) {
  console.log(scenes.join("\n"));
  process.exit(0);
}
if (!scenes.includes(scene as (typeof scenes)[number])) {
  throw new Error(`unknown scene ${JSON.stringify(scene)}; use --list`);
}
const sceneId = scenes.indexOf(scene as (typeof scenes)[number]);

const SHADER = /* wgsl */ `
struct Uniforms { time: f32, width: f32, height: f32, scene: f32 };
@group(0) @binding(0) var<uniform> u: Uniforms;

@vertex
fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let corners = array(vec2f(-1.0, -3.0), vec2f(3.0, 1.0), vec2f(-1.0, 1.0));
  return vec4f(corners[index], 0.0, 1.0);
}

fn sdTorus(p: vec3f, t: vec2f) -> f32 {
  let q = vec2f(length(p.xz) - t.x, p.y);
  return length(q) - t.y;
}

fn map(p: vec3f) -> f32 {
  let a = u.time * 0.7;
  let rotY = mat3x3f(
    vec3f(cos(a), 0.0, sin(a)),
    vec3f(0.0, 1.0, 0.0),
    vec3f(-sin(a), 0.0, cos(a))
  );
  let b = u.time * 0.9;
  let rotX = mat3x3f(
    vec3f(1.0, 0.0, 0.0),
    vec3f(0.0, cos(b), -sin(b)),
    vec3f(0.0, sin(b), cos(b))
  );
  return sdTorus(rotX * (rotY * p), vec2f(1.0, 0.42));
}

fn hash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn terrainHeight(p: vec2f) -> f32 {
  return floor(2.0 + sin(p.x * 0.25) * 1.2 + cos(p.y * 0.22) * 1.1 + sin((p.x + p.y) * 0.11) * 0.8);
}

fn voxelMaterial(cell: vec3i) -> f32 {
  let p = vec2f(f32(cell.x), f32(cell.z));
  let y = f32(cell.y);
  let ground = terrainHeight(p);

  // A small ruin gives the orbiting camera a landmark in the endless terrain.
  if (max(abs(p.x), abs(p.y)) <= 4.0) {
    if (y == 4.0 && max(abs(p.x), abs(p.y)) <= 3.0) { return 3.0; }
    if (abs(p.x) == 3.0 && abs(p.y) == 3.0 && y >= 5.0 && y <= 8.0) { return 3.0; }
    if (p.x == 0.0 && p.y == 0.0 && y >= 5.0 && y <= 10.0) { return 5.0; }
  }

  if (y <= ground) {
    if (y == ground && hash(p) > 0.94) { return 5.0; }
    if (y == ground) { return 1.0; }
    if (y > ground - 3.0) { return 2.0; }
    return 3.0;
  }
  if (y <= 1.0) { return 4.0; }

  let grove = floor(p / 7.0);
  let local = p - grove * 7.0;
  let trunk = vec2f(
    floor(hash(grove + vec2f(19.3, 4.7)) * 5.0) + 1.0,
    floor(hash(grove + vec2f(8.1, 23.6)) * 5.0) + 1.0
  );
  let trunkPosition = grove * 7.0 + trunk;
  let trunkGround = terrainHeight(trunkPosition);
  if (max(abs(trunkPosition.x), abs(trunkPosition.y)) > 6.0) {
    if (all(local == trunk) && y > trunkGround && y <= trunkGround + 3.0) { return 2.0; }
    let crown = max(abs(local.x - trunk.x), abs(local.y - trunk.y));
    if (crown <= 1.0 && y >= trunkGround + 3.0 && y <= trunkGround + 5.0) { return 6.0; }
  }
  return 0.0;
}

fn voxelScene(uv: vec2f) -> vec4f {
  let angle = u.time * 0.18;
  let ro = vec3f(sin(angle) * 16.0, 9.0 + sin(u.time * 0.31), cos(angle) * 16.0);
  let forward = normalize(vec3f(0.0, 3.5, 0.0) - ro);
  let right = normalize(cross(forward, vec3f(0.0, 1.0, 0.0)));
  let up = cross(right, forward);
  let rd = normalize(forward * 1.65 + right * uv.x + up * uv.y);
  let sun = normalize(vec3f(-0.5, 0.8, -0.35));

  var color = mix(vec3f(0.04, 0.08, 0.18), vec3f(0.35, 0.68, 0.95), clamp(rd.y * 0.7 + 0.5, 0.0, 1.0));
  color += vec3f(1.0, 0.65, 0.25) * pow(max(dot(rd, sun), 0.0), 96.0);

  var cell = vec3i(floor(ro));
  let stepDirection = vec3i(
    select(-1, 1, rd.x >= 0.0),
    select(-1, 1, rd.y >= 0.0),
    select(-1, 1, rd.z >= 0.0)
  );
  let delta = abs(1.0 / rd);
  var side = vec3f(
    select(ro.x - f32(cell.x), f32(cell.x + 1) - ro.x, rd.x >= 0.0) * delta.x,
    select(ro.y - f32(cell.y), f32(cell.y + 1) - ro.y, rd.y >= 0.0) * delta.y,
    select(ro.z - f32(cell.z), f32(cell.z + 1) - ro.z, rd.z >= 0.0) * delta.z
  );
  var normal = vec3f(0.0);
  var distance = 0.0;
  var material = 0.0;

  for (var i = 0; i < 120; i++) {
    material = voxelMaterial(cell);
    if (material > 0.0) { break; }
    if (side.x < side.y && side.x < side.z) {
      distance = side.x;
      side.x += delta.x;
      cell.x += stepDirection.x;
      normal = vec3f(-f32(stepDirection.x), 0.0, 0.0);
    } else if (side.y < side.z) {
      distance = side.y;
      side.y += delta.y;
      cell.y += stepDirection.y;
      normal = vec3f(0.0, -f32(stepDirection.y), 0.0);
    } else {
      distance = side.z;
      side.z += delta.z;
      cell.z += stepDirection.z;
      normal = vec3f(0.0, 0.0, -f32(stepDirection.z));
    }
    if (distance > 45.0) { break; }
  }

  if (material > 0.0) {
    var base = vec3f(0.25, 0.62, 0.2);
    if (material == 2.0) { base = vec3f(0.43, 0.22, 0.09); }
    if (material == 3.0) { base = vec3f(0.38, 0.42, 0.5); }
    if (material == 4.0) { base = vec3f(0.05, 0.35, 0.75); }
    if (material == 5.0) { base = vec3f(1.0, 0.3, 0.85); }
    if (material == 6.0) { base = vec3f(0.08, 0.38, 0.13); }
    let hit = ro + rd * distance;
    let f = fract(hit);
    var edge = 1.0;
    if (abs(normal.x) < 0.5) { edge = min(edge, min(f.x, 1.0 - f.x)); }
    if (abs(normal.y) < 0.5) { edge = min(edge, min(f.y, 1.0 - f.y)); }
    if (abs(normal.z) < 0.5) { edge = min(edge, min(f.z, 1.0 - f.z)); }
    let grid = smoothstep(0.015, 0.06, edge);
    let lighting = 0.22 + max(dot(normal, sun), 0.0) * 0.78;
    let glow = select(vec3f(0.0), base * 0.65, material == 5.0);
    let shaded = base * lighting * (0.72 + 0.28 * grid) + glow;
    color = mix(shaded, color, smoothstep(20.0, 45.0, distance));
  }
  return vec4f(pow(color, vec3f(0.4545)), 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let res = vec2f(u.width, u.height);
  var uv = (pos.xy * 2.0 - res) / res.y;
  uv.y = -uv.y;
  if (u.scene > 0.5) { return voxelScene(uv); }
  let ro = vec3f(0.0, 0.0, -3.2);
  let rd = normalize(vec3f(uv, 1.6));
  var t = 0.0;
  var hit = false;
  for (var i = 0; i < 80; i++) {
    let d = map(ro + rd * t);
    if (d < 0.001) { hit = true; break; }
    t += d;
    if (t > 8.0) { break; }
  }
  var color = mix(vec3f(0.09, 0.05, 0.2), vec3f(0.01, 0.02, 0.06), length(uv) * 0.6);
  if (hit) {
    let p = ro + rd * t;
    let e = vec2f(0.001, 0.0);
    let n = normalize(vec3f(
      map(p + e.xyy) - map(p - e.xyy),
      map(p + e.yxy) - map(p - e.yxy),
      map(p + e.yyx) - map(p - e.yyx)
    ));
    let light = normalize(vec3f(0.6, 0.8, -0.5));
    let diffuse = max(dot(n, light), 0.0);
    let fresnel = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
    let base = 0.5 + 0.5 * cos(vec3f(0.0, 2.1, 4.2) + p.x + p.y + u.time * 0.5);
    color = base * (0.15 + 0.85 * diffuse) + fresnel * vec3f(0.9, 0.7, 1.0) * 0.6;
  }
  return vec4f(pow(color, vec3f(0.4545)), 1.0);
}
`;

const out = process.stdout;
const cols = Math.max(1, out.columns ?? 100);
const rows = Math.max(1, (out.rows ?? 30) - 1);
const width = cols;
const height = rows * 2;
const bytesPerRow = Math.ceil((width * 4) / 256) * 256;

const adapter = await navigator.gpu.requestAdapter();
if (!adapter) throw new Error("no GPU adapter");
const device = await adapter.requestDevice();
const module = device.createShaderModule({ code: SHADER });
const target = device.createTexture({
  size: { width, height },
  format: "rgba8unorm",
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
});
const uniforms = device.createBuffer({
  size: 16,
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});
const readback = device.createBuffer({
  size: bytesPerRow * height,
  usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
});
const pipeline = device.createRenderPipeline({
  layout: "auto",
  vertex: { module, entryPoint: "vs" },
  fragment: { module, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
});
const bindGroup = device.createBindGroup({
  layout: pipeline.getBindGroupLayout(0),
  entries: [{ binding: 0, resource: { buffer: uniforms } }],
});

const renderFrame = async (time: number, frameScene = sceneId) => {
  device.queue.writeBuffer(
    uniforms,
    0,
    new Float32Array([time, width, height, frameScene])
  );
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: target.createView(),
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      },
    ],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3);
  pass.end();
  encoder.copyTextureToBuffer(
    { texture: target },
    { buffer: readback, bytesPerRow, rowsPerImage: height },
    { width, height }
  );
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const pixels = new Uint8Array(readback.getMappedRange().slice(0));
  readback.unmap();
  return pixels;
};

const blit = (pixels: Uint8Array) => {
  const parts: string[] = ["\x1b[?2026h\x1b[H"];
  for (let row = 0; row < rows; row++) {
    let previous = "";
    for (let col = 0; col < cols; col++) {
      const top = row * 2 * bytesPerRow + col * 4;
      const bottom = (row * 2 + 1) * bytesPerRow + col * 4;
      const colors = `\x1b[38;2;${pixels[top]};${pixels[top + 1]};${pixels[top + 2]};48;2;${pixels[bottom]};${pixels[bottom + 1]};${pixels[bottom + 2]}m`;
      if (colors !== previous) {
        parts.push(colors);
        previous = colors;
      }
      parts.push("▀");
    }
    parts.push("\x1b[0m");
    if (row < rows - 1) parts.push("\n");
  }
  parts.push("\x1b[?2026l");
  return parts.join("");
};

if (!out.isTTY) {
  const started = performance.now();
  const results: string[] = [];
  const signatures = new Set<number>();
  for (const [index, name] of scenes.entries()) {
    const pixels = await renderFrame(1.0, index);
    const colors = new Set<number>();
    let signature = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = y * bytesPerRow + x * 4;
        const color =
          (pixels[offset] << 16) |
          (pixels[offset + 1] << 8) |
          pixels[offset + 2];
        colors.add(color);
        signature = (signature * 31 + color) >>> 0;
      }
    }
    signatures.add(signature);
    results.push(`${name} ${colors.size > 16 ? "OK" : "FLAT"}`);
  }
  const elapsed = (performance.now() - started).toFixed(1);
  const okay =
    results.every((result) => result.endsWith("OK")) &&
    signatures.size === scenes.length;
  console.log(
    `GPU self-check: rendered ${width}x${height} via ${adapter.info?.description ?? "Dawn"} in ${elapsed}ms; ${results.join(", ")}`
  );
  process.exit(okay ? 0 : 1);
}

const secondsArg = process.argv.indexOf("--seconds");
const seconds =
  secondsArg >= 0 ? Number(process.argv[secondsArg + 1]) || 20 : 20;
const started = performance.now();
let stopped = false;
const cleanup = () => {
  if (stopped) return;
  stopped = true;
  out.write("\x1b[?2026l\x1b[?25h\x1b[?1049l");
};
const write = async (payload: string) => {
  if (!out.write(payload)) await once(out, "drain");
};
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

out.write("\x1b[?1049h\x1b[?25l");
try {
  while (!stopped && (performance.now() - started) / 1000 < seconds) {
    const frameStart = performance.now();
    const pixels = await renderFrame((performance.now() - started) / 1000);
    if (stopped) break;
    await write(blit(pixels));
    const budget = 1000 / 30 - (performance.now() - frameStart);
    if (budget > 0) await new Promise((resolve) => setTimeout(resolve, budget));
  }
} finally {
  cleanup();
}
