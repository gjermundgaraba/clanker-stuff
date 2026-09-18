/** @param {unknown} input The task explicitly includes non-string route rejection. */
export function parseRoute(input) {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Route parsing must reject non-strings before splitting and validate both slash-separated components below.
  if (typeof input !== "string") {
    throw new TypeError("route must be a string");
  }

  const parts = input.split("/");

  if (parts.length !== 2) {
    throw new TypeError("route must contain exactly one slash");
  }

  const [service, region] = parts.map((part) => part.trim().toLowerCase());

  if (!service || !region) {
    throw new TypeError("route parts cannot be empty");
  }

  return { region, service };
}
