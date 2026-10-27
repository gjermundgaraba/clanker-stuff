/** Theme tokens every status surface may use. See docs/color.md for what each one means. */
export type Tone =
  | "text"
  | "muted"
  | "dim"
  | "accent"
  | "success"
  | "warning"
  | "error";

/** Usage meters stay neutral until they need attention. */
export const percentTone = (
  percent: number
): Extract<Tone, "text" | "warning" | "error"> => {
  if (percent >= 90) {
    return "error";
  }

  return percent >= 70 ? "warning" : "text";
};
