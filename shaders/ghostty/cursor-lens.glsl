// Cursor lens for Ghostty 1.3+: a tiny liquid refraction settles after each
// cursor move. The one-pixel displacement keeps nearby text readable.
//
// custom-shader = /absolute/path/to/cursor-lens.glsl

vec2 cursorCenter(vec4 cursor) {
  return vec2(cursor.x + cursor.z * 0.5, cursor.y - cursor.w * 0.5);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  vec2 delta = fragCoord - cursorCenter(iCurrentCursor);
  float distanceFromCursor = length(delta);
  float radius = max(iCurrentCursor.w * 2.5, 24.0);
  float age = iTime - iTimeCursorChange;
  float active = step(0.0, age) * (1.0 - smoothstep(0.12, 0.55, age)) * float(iFocus);
  active *= float(iCursorVisible);
  float lens = (1.0 - smoothstep(radius * 0.25, radius, distanceFromCursor));
  float ripple = sin(distanceFromCursor * 0.22 - age * 20.0) * lens * active;
  vec2 offset = delta / max(distanceFromCursor, 1.0) * ripple / iResolution.xy;
  vec4 base = texture(iChannel0, uv + offset);
  vec3 accent = mix(iCurrentCursorColor.rgb, iPalette[6], 0.25);
  float rim = exp(-abs(distanceFromCursor - radius * 0.72) / 2.5) * active;
  fragColor = vec4(base.rgb + accent * rim * 0.08, base.a);
}
