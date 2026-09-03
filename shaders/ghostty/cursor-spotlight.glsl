// Cursor spotlight for Ghostty 1.3+: a quiet breathing halo makes the cursor
// easy to reacquire while dimming distant content by only three percent.
//
// custom-shader = /absolute/path/to/cursor-spotlight.glsl

vec2 cursorCenter(vec4 cursor) {
  return vec2(cursor.x + cursor.z * 0.5, cursor.y - cursor.w * 0.5);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec4 base = texture(iChannel0, fragCoord / iResolution.xy);
  float distanceFromCursor = length(fragCoord - cursorCenter(iCurrentCursor));
  float radius = max(iCurrentCursor.w * 4.0, 42.0);
  float nearCursor = 1.0 - smoothstep(radius * 0.35, radius, distanceFromCursor);
  float focused = float(iFocus) * float(iCursorVisible);
  vec3 color = mix(base.rgb, iBackgroundColor, (1.0 - nearCursor) * focused * 0.03);
  vec3 accent = mix(iCurrentCursorColor.rgb, iPalette[14], 0.2);
  float breath = 0.015 + 0.01 * (0.5 + 0.5 * sin(iTime * 2.4));
  color += accent * nearCursor * breath * focused;
  fragColor = vec4(color, base.a);
}
