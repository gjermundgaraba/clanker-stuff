import { Type } from "typebox";
import type { Static } from "typebox";

export const MESSAGE_TYPE = "peers:message";

export const SENT = "peers:sent";

export const UNDELIVERED = "peers:undelivered";

export const undeliveredSchema = Type.Object({
  to: Type.String(),
  text: Type.String(),
  reason: Type.String(),
  live: Type.Array(Type.String()),
});

export type Undelivered = Static<typeof undeliveredSchema>;

export const undeliveredText = ({ to, reason, live }: Undelivered): string =>
  `Not delivered to "${to}": ${reason}. ${live.length ? `Live peers: ${live.join(", ")}.` : "No other session has a name."}`;
