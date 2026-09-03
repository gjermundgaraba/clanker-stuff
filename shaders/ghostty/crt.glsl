// Subtle CRT: barrel curvature, scanlines, chromatic aberration, vignette.
// Tuned to keep text readable for daily use.

vec2 curve(vec2 uv) {
  uv = uv * 2.0 - 1.0;
  vec2 offset = abs(uv.yx) / vec2(6.5, 4.5);
  uv = uv + uv * offset * offset;
  return uv * 0.5 + 0.5;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = curve(fragCoord / iResolution.xy);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  float aberration = 1.2 / iResolution.x;
  vec3 color;
  color.r = texture(iChannel0, uv + vec2(aberration, 0.0)).r;
  color.g = texture(iChannel0, uv).g;
  color.b = texture(iChannel0, uv - vec2(aberration, 0.0)).b;
  float scanline = 0.93 + 0.07 * sin(uv.y * iResolution.y * 3.14159);
  float vignette = 1.0 - 0.22 * pow(length(uv * 2.0 - 1.0), 2.0);
  float flicker = 0.995 + 0.005 * sin(iTime * 8.0);
  fragColor = vec4(color * scanline * vignette * flicker, 1.0);
}
