// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- contextual ToolDefinition result types instantiate T
export const prepareForegroundArguments = <T>(args: unknown): T => {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- schema validation reports the original invalid value
    return args as T;
  }
  const prepared = Object.fromEntries(
    Object.entries(args).filter(
      ([name]) => name !== "is_background" && name !== "run_in_background"
    )
  );
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deprecated fields were removed before current-schema validation
  return prepared as T;
};
