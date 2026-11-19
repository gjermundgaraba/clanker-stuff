import { safeText } from "@clanker-stuff/pi-tool-rendering/text";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

/** Delivers feedback to the branch a Plannotator command started on. */
export type FeedbackTarget = (
  ctx: ExtensionCommandContext
) => (text: string) => void;

// Pi switches the leaf before session_tree handlers run: https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/core/agent-session.ts#L4292-L4313
export const createFeedbackTarget =
  (pi: ExtensionAPI): FeedbackTarget =>
  ({ sessionManager, ui }) => {
    const origin = sessionManager.getLeafId();

    return (text) => {
      if (
        origin === null ||
        sessionManager.getBranch().some(({ id }) => id === origin)
      ) {
        pi.sendUserMessage(text, { deliverAs: "followUp" });

        return;
      }

      ui.pasteToEditor(safeText(text));
      ui.notify(
        "Plannotator feedback came back for another branch; it is in the editor instead of sent.",
        "warning"
      );
    };
  };
