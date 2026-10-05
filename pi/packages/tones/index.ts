/** Theme tokens every status surface may use. See docs/color.md for what each one means. */
export type Tone = "text" | "muted" | "dim" | "accent" | "success" | "warning" | "error";

/** Usage meters stay neutral until they need attention. */
export const percentTone = (percent: number): Tone =>
  percent >= 90 ? "error" : percent >= 70 ? "warning" : "text";
