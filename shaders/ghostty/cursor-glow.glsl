// Cursor glow: a soft breathing halo around the cursor in the cursor's own
// color. Subtle enough for daily use; pairs well after crt.glsl in the chain.

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  fragColor = texture(iChannel0, uv);

  vec2 center =
    iCurrentCursor.xy + vec2(iCurrentCursor.z, -iCurrentCursor.w) * 0.5;
  float dist = length(fragCoord.xy - center);
  float reach = max(iCurrentCursor.w, 8.0) * 3.0;
  float pulse = 0.75 + 0.25 * sin(iTime * 2.2);
  float settle = clamp((iTime - iTimeCursorChange) * 4.0, 0.0, 1.0);
  float glow =
    exp(-(dist * dist) / (reach * reach)) *
    pulse *
    (0.35 + 0.35 * settle) *
    float(iCursorVisible);
  fragColor.rgb += iCurrentCursorColor.rgb * glow;
}
