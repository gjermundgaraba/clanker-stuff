// Claude Code's result messages read as a turn's outcome.

import { describe, expect, it } from "vite-plus/test";

import { resultErrorText } from "../../query/result.js";
import { errorResult, successResult } from "../fixtures/sdk.js";

// Claude Code reports API failures (429 capacity, overload, prompt-too-long) as a result
// with is_error set while the subtype stays "success".
const RATE_LIMITED =
  "API Error: Server is temporarily limiting requests (not your usage limit): Rate limited";

describe(resultErrorText, () => {
  it("treats is_error on a success-shaped result as a failure", () => {
    expect(resultErrorText(successResult(RATE_LIMITED, true))).toBe(
      RATE_LIMITED
    );
  });

  it("returns undefined for a genuine success", () => {
    expect(resultErrorText(successResult("a summary"))).toBeUndefined();
  });

  it("joins errors[] for the dedicated error subtypes", () => {
    expect(
      resultErrorText(errorResult("error_during_execution", ["boom", "bang"]))
    ).toBe("boom\nbang");
  });

  // An empty message marks the turn errored with nothing to show the user.
  it("never returns an empty message for a failure", () => {
    expect(resultErrorText(successResult("", true))).toMatch(/\S/u);
    expect(resultErrorText(errorResult("error_max_budget_usd", []))).toMatch(
      /\S/u
    );
  });
});
