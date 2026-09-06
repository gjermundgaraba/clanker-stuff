import type { TestEvent } from "node:test/reporters";

/** Only the runner's cumulative summary is a grade; per-file summaries are not. */
export default async function* summaryReporter(source: AsyncIterable<TestEvent>) {
  for await (const event of source) {
    if (event.type === "test:summary" && event.data.file === undefined) {
      yield `${JSON.stringify(event.data)}\n`;
    }
  }
}
