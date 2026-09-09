export interface ProcessMetadataSource {
  exitCode: number | null;
  fullOutputPath?: string;
  sessionId?: number;
  status: "exited" | "killed" | "running";
}

/** Formats the model-facing trailer appended to every exec_command and write_stdin result. */
export const formatProcessMetadata = (result: ProcessMetadataSource): string => {
  let status = `Process exited with code ${result.exitCode ?? "unknown"}.`;
  if (result.status === "running") {
    status = "Process is still running.";
  } else if (result.status === "killed") {
    status = "Process was killed.";
  }
  const output = [status];
  if (result.fullOutputPath !== undefined && result.fullOutputPath.length > 0) {
    output.push(`[Full output: ${result.fullOutputPath}]`);
  }
  if (result.sessionId !== undefined) {
    output.push(`Session ID: ${result.sessionId}`);
  }
  return output.join("\n\n");
};
