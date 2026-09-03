// Ripple: the whole terminal surface waves like water. Demo shader —
// too distorting for daily use, fun for showing off the pipeline.

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec2 delta = uv - vec2(0.5);
  delta.x *= iResolution.x / iResolution.y;
  float dist = length(delta) + 1e-6;
  float wave = sin(dist * 42.0 - iTime * 4.5) * 0.005 * exp(-dist * 1.4);
  fragColor = texture(iChannel0, uv + (delta / dist) * wave);
}
