import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TObject } from "typebox";
import { Value } from "typebox/value";

const strict = { additionalProperties: false } as const;

export const prepareForegroundArguments = <TParameters extends TObject>(
  parameters: TParameters,
): NonNullable<ToolDefinition<TParameters>["prepareArguments"]> => {
  const legacyParameters = Type.Object(
    {
      ...parameters.properties,
      is_background: Type.Optional(Type.Boolean()),
      run_in_background: Type.Optional(Type.Boolean()),
    },
    strict,
  );
  return (args) => {
    const {
      is_background: _isBackground,
      run_in_background: _runInBackground,
      ...foreground
    } = Value.Parse(legacyParameters, args);
    return Value.Parse(parameters, foreground);
  };
};
