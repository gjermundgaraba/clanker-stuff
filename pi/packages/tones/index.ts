import { Type } from "typebox";
import type { Static } from "typebox";

/** Theme tokens every status surface may use. See docs/color.md for what each one means. */
export const ToneSchema = Type.Union([
  Type.Literal("text"),
  Type.Literal("muted"),
  Type.Literal("dim"),
  Type.Literal("accent"),
  Type.Literal("success"),
  Type.Literal("warning"),
  Type.Literal("error"),
]);

export type Tone = Static<typeof ToneSchema>;

/** Usage meters stay neutral until they need attention. */
export const percentTone = (percent: number): Tone =>
  percent >= 90 ? "error" : percent >= 70 ? "warning" : "text";
