import { inlineText } from "@clanker-stuff/pi-tool-rendering/text";

import type { Letter } from "./mailbox.js";
import type { Peer } from "./registry.js";

export const letterText = (letter: Letter): string =>
  [
    `Message from the session named "${letter.from}":`,
    "",
    letter.text,
    "",
    `To answer, call peer_send with to "${letter.from}"; your own reply text is not sent to it.`,
  ].join("\n");

export const peerRows = (
  peers: readonly Peer[],
  self: string | undefined
): string =>
  peers.length
    ? peers
        .map(
          (peer) =>
            `${inlineText(peer.name)}${peer.sessionId === self ? " (this session)" : ""} · pid ${peer.pid} · ${inlineText(peer.cwd)}`
        )
        .join("\n")
    : "No live session has a peer name.";
