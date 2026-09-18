const REGION_ORDER = ["us", "eu", "apac"];

/** @param {{service: string, target: string, attempts?: number|string, regions: string[], [key: string]: unknown}} config */
export function planDeployment(config) {
  const service = config.service.trim().toLowerCase();

  if (!service) throw new TypeError("invalid service");
  const target = config.target.trim().toLowerCase();
  const attempts = config.attempts === undefined ? 4 : config.attempts;

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The benchmark contract rejects numeric strings and non-integer attempts; this is the complete range decoder.
  if (typeof attempts !== "number" || !Number.isInteger(attempts) || attempts < 0 || attempts > 5) {
    throw new TypeError("invalid attempts");
  }

  const regions = [...new Set(config.regions.map((value) => value.trim().toLowerCase()))];
  regions.sort((a, b) => REGION_ORDER.indexOf(a) - REGION_ORDER.indexOf(b));

  return { attempts, regions, service, target };
}
