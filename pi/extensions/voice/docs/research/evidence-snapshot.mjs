import { chmodSync, existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

const remove = (directory) => {
  rmSync(directory, { force: true, recursive: true });
};

/**
 * Creates a private, same-filesystem staging directory for generated evidence.
 *
 * Publishing uses directory renames. If replacing an existing snapshot fails,
 * the previous directory is renamed back before the error is returned.
 */
export const createEvidenceSnapshot = (captureDirectory) => {
  const evidenceDirectory = path.join(captureDirectory, "evidence");
  const temporaryDirectory = mkdtempSync(path.join(captureDirectory, ".evidence-tmp-"));
  chmodSync(temporaryDirectory, 0o700);

  let finished = false;

  return {
    directory: temporaryDirectory,
    discard() {
      if (!finished) {
        remove(temporaryDirectory);
        finished = true;
      }
    },
    evidenceDirectory,
    publish() {
      if (finished) {
        throw new Error("Evidence snapshot is already finished.");
      }

      const previousDirectory = `${temporaryDirectory}-previous`;
      const hadPreviousSnapshot = existsSync(evidenceDirectory);
      if (hadPreviousSnapshot) {
        renameSync(evidenceDirectory, previousDirectory);
      }

      try {
        renameSync(temporaryDirectory, evidenceDirectory);
      } catch (error) {
        if (hadPreviousSnapshot) {
          try {
            renameSync(previousDirectory, evidenceDirectory);
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              "Could not publish evidence or restore the previous snapshot.",
            );
          }
        }
        throw error;
      }

      finished = true;
      if (hadPreviousSnapshot) {
        try {
          remove(previousDirectory);
        } catch {
          // The new snapshot is already committed. Leave the private sibling
          // for manual cleanup rather than reporting a failed extraction.
        }
      }
    },
  };
};
