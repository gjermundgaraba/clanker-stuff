import { Type } from "typebox";

export const TerminatingToolResultSchema = Type.Object({ terminate: Type.Literal(true) });

/** System prompt section carrying collaboration guidance; Pi wraps it in `<collaboration>`. */
export const COLLABORATION_SECTION = "collaboration";
