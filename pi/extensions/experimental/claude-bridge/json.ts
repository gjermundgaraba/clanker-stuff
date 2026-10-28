import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";

export const isJsonObject = (
  value: JsonValue | undefined
): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isJsonArray = (
  value: JsonValue | undefined
): value is readonly JsonValue[] => Array.isArray(value);

/** A plain-JSON copy of `value`. TypeBox schemas are JSON Schema at runtime but carry
 *  symbol-keyed metadata and are typed as TypeBox nodes, and parsed stream input is
 *  untyped, so the copy is rebuilt rather than asserted. Non-JSON leaves are dropped. */
export const toJsonValue = (value: unknown): JsonValue | undefined => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const json = toJsonValue(item);

      return json === undefined ? [] : [json];
    });
  }

  if (typeof value !== "object") {
    return undefined;
  }

  const result: JsonObject = {};

  for (const [key, item] of Object.entries(value)) {
    const json = toJsonValue(item);

    if (json !== undefined) {
      result[key] = json;
    }
  }

  return result;
};

/** `value` as a JSON object, or undefined when it is not one. */
export const toJsonObject = (value: unknown): JsonObject | undefined => {
  const json = toJsonValue(value);

  return isJsonObject(json) ? json : undefined;
};
