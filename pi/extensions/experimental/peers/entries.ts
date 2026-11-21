import { Type } from "typebox";
import type { Static } from "typebox";

/** A letter delivered to this session, as a custom message whose details are the letter. */
export const MESSAGE_TYPE = "peers:message";

/** A letter this session sent; its data is the letter. */
export const SENT = "peers:sent";

/** A send this session tried that reached no one. */
export const UNDELIVERED = "peers:undelivered";

export const undeliveredSchema = Type.Object({
  to: Type.String(),
  text: Type.String(),
  reason: Type.String(),
  live: Type.Array(Type.String()),
});

export type Undelivered = Static<typeof undeliveredSchema>;

/** What the model reads when a send fails. */
export const undeliveredText = ({ to, reason, live }: Undelivered): string =>
  `Not delivered to "${to}": ${reason}. ${live.length ? `Live peers: ${live.join(", ")}.` : "No other session has a name."}`;
