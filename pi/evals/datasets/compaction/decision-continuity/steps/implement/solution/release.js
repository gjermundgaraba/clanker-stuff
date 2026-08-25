const REGION_ORDER = ["us", "eu", "apac"];

export function normalizeRelease(config) {
  const channel = config.channel.trim().toLowerCase();
  if (!["stable", "beta", "canary"].includes(channel)) throw new TypeError("invalid channel");
  const rolloutPercent = config.rolloutPercent === undefined ? 100 : Number(config.rolloutPercent);
  if (!Number.isInteger(rolloutPercent) || rolloutPercent < 0 || rolloutPercent > 100) {
    throw new TypeError("invalid rolloutPercent");
  }
  const seen = new Set();
  const artifacts = config.artifacts
    .map((value) => value.trim())
    .filter((value) => {
      const key = value.toLowerCase();
      if (!value || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const regions = config.regions.map((value) => value.trim().toLowerCase());
  regions.sort((a, b) => REGION_ORDER.indexOf(a) - REGION_ORDER.indexOf(b));
  return { artifacts, channel, regions, rolloutPercent };
}
