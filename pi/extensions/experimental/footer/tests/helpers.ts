import type {
  ExtensionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

export const sessionReads = (
  session: SessionManager
): Partial<ExtensionContext["sessionManager"]> => ({
  buildSessionProjection: () => session.buildSessionProjection(),
  getBranch: () => session.getBranch(),
  getEntries: () => session.getEntries(),
  getHeader: () => session.getHeader(),
  getLeafId: () => session.getLeafId(),
  getSessionId: () => session.getSessionId(),
  getSessionName: () => session.getSessionName(),
});
