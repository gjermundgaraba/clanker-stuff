export function parseRoute(input) {
  const [service, region] = String(input).split("/").filter(Boolean);
  return { service, region };
}
