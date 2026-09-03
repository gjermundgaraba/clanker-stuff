// Focus ripple for Ghostty 1.3+: a brief palette-colored ring confirms which
// pane regained focus without leaving a persistent overlay.
//
// custom-shader = /absolute/path/to/focus-ripple.glsl

vec2 cursorCenter(vec4 cursor) {
  return vec2(cursor.x + cursor.z * 0.5, cursor.y - cursor.w * 0.5);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec4 base = texture(iChannel0, fragCoord / iResolution.xy);
  float age = iTime - iTimeFocus;
  float progress = smoothstep(0.0, 0.65, age);
  float radius = progress * min(iResolution.x, iResolution.y) * 0.42;
  float ring = exp(-abs(length(fragCoord - cursorCenter(iCurrentCursor)) - radius) / 3.0);
  float visible = step(0.0, age) * (1.0 - smoothstep(0.45, 0.8, age)) * float(iFocus);
  vec3 accent = mix(iPalette[6], iPalette[13], 0.35);
  fragColor = vec4(base.rgb + accent * ring * visible * 0.12, base.a);
}
