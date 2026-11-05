import { openSession } from "cc-session-io";

export const sessionContents = (sessionId: string, cwd: string) =>
  openSession({ sessionId, projectPath: cwd }).messages.map(
    (record) => record.message.content
  );
