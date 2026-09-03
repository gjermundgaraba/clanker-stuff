// Bloom: bright glyphs bleed a soft halo. Gaussian-weighted 7x7 gather
// with a luminance threshold so the background stays clean.

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec4 base = texture(iChannel0, uv);
  vec3 glow = vec3(0.0);
  float total = 0.0;
  for (int x = -3; x <= 3; x++) {
    for (int y = -3; y <= 3; y++) {
      vec2 offset = vec2(float(x), float(y)) * 2.0 / iResolution.xy;
      vec3 sample3 = texture(iChannel0, uv + offset).rgb;
      float luminance = dot(sample3, vec3(0.299, 0.587, 0.114));
      float weight = exp(-float(x * x + y * y) * 0.12);
      glow += sample3 * max(0.0, luminance - 0.4) * weight;
      total += weight;
    }
  }
  glow /= total;
  float pulse = 1.25 + 0.35 * sin(iTime * 2.0);
  fragColor = vec4(base.rgb + glow * pulse, 1.0);
}
