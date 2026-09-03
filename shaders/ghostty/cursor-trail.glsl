// Cursor trail using Ghostty's cursor uniforms (verified in Ghostty 1.3.1):
// a tapered streak sweeps from the previous cursor position to the current
// one over ~250ms, tinted with the cursor color, then fades out.

float easeOut(float x) {
  return 1.0 - pow(1.0 - x, 3.0);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  fragColor = texture(iChannel0, uv);

  float duration = 0.25;
  float progress = easeOut(clamp((iTime - iTimeCursorChange) / duration, 0.0, 1.0));

  vec2 currentCenter =
    iCurrentCursor.xy + vec2(iCurrentCursor.z, -iCurrentCursor.w) * 0.5;
  vec2 previousCenter =
    iPreviousCursor.xy + vec2(iPreviousCursor.z, -iPreviousCursor.w) * 0.5;
  vec2 head = mix(previousCenter, currentCenter, progress);

  vec2 toPoint = fragCoord.xy - previousCenter;
  vec2 along = head - previousCenter;
  float h = clamp(dot(toPoint, along) / max(dot(along, along), 1.0), 0.0, 1.0);
  float dist = length(toPoint - along * h);
  float radius = mix(1.5, max(iCurrentCursor.z, iCurrentCursor.w) * 0.55, h);

  float mask = 1.0 - smoothstep(radius * 0.4, radius, dist);
  float fade = 1.0 - progress;
  fragColor.rgb = mix(
    fragColor.rgb,
    iCurrentCursorColor.rgb,
    mask * fade * 0.85 * float(iCursorVisible)
  );
}
