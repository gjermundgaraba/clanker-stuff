const REGION_ORDER = ["us", "eu", "apac"];

export function planDeployment(config) {
  const service = config.service.trim().toLowerCase();
  if (!service) throw new TypeError("invalid service");
  const target = config.target.trim().toLowerCase();
  const attempts = config.attempts === undefined ? 4 : config.attempts;
  if (!Number.isInteger(attempts) || attempts < 0 || attempts > 5) {
    throw new TypeError("invalid attempts");
  }
  const regions = [
    ...new Set(config.regions.map((value) => value.trim().toLowerCase())),
  ];
  regions.sort((a, b) => REGION_ORDER.indexOf(a) - REGION_ORDER.indexOf(b));
  return { attempts, regions, service, target };
}
