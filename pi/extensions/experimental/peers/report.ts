import { homedir } from "node:os";

import { inlineText } from "@clanker-stuff/pi-tool-rendering/text";
import { Type } from "typebox";
import type { Static } from "typebox";

import type { Letter } from "./mailbox.js";
import { peerSchema } from "./registry.js";

export const peerListSchema = Type.Object({
  peers: Type.Array(peerSchema),
  self: Type.Optional(Type.String()),
});

export type PeerList = Static<typeof peerListSchema>;

export const letterText = (letter: Letter): string =>
  [
    `Message ${letter.id} from the session named "${letter.from}"${letter.replyTo === undefined ? "" : `, answering your message ${letter.replyTo}`}:`,
    "",
    letter.text,
    "",
    `To answer, call peer_send with to "${letter.from}" and replyTo "${letter.id}"; your own reply text is not sent to it.`,
  ].join("\n");

/** A working directory with the home directory shown as ~. */
export const shortPath = (cwd: string, home = homedir()): string =>
  cwd === home || cwd.startsWith(`${home}/`)
    ? `~${cwd.slice(home.length)}`
    : cwd;

export const peerRows = ({ peers, self }: PeerList): string =>
  peers.length
    ? peers
        .map(
          (peer) =>
            `${inlineText(peer.name)}${peer.sessionId === self ? " (this session)" : ""} · pid ${peer.pid} · ${inlineText(shortPath(peer.cwd))}`
        )
        .join("\n")
    : "No live session has a peer name.";
