import type { ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme } from "@earendil-works/pi-tui";

/** The session reads the footer performs, live against a real in-memory session. */
export const sessionReads = (
  session: SessionManager,
): Partial<ExtensionContext["sessionManager"]> => ({
  buildSessionProjection: () => session.buildSessionProjection(),
  getBranch: () => session.getBranch(),
  getEntries: () => session.getEntries(),
  getHeader: () => session.getHeader(),
  getLeafId: () => session.getLeafId(),
  getSessionId: () => session.getSessionId(),
  getSessionName: () => session.getSessionName(),
});

export const editorTheme: EditorTheme = {
  borderColor: (text) => text,
  selectList: {
    description: (text) => text,
    noMatch: (text) => text,
    scrollInfo: (text) => text,
    selectedPrefix: (text) => text,
    selectedText: (text) => text,
  },
};
