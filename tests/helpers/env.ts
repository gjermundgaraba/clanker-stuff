type EnvPatch = Record<string, string | undefined>;
interface RestoreEntry {
  key: string;
  hadValue: boolean;
  value: string | undefined;
}

const restorePatch = (entries: RestoreEntry[]) => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.hadValue) {
      process.env[entry.key] = entry.value;
    } else {
      Reflect.deleteProperty(process.env, entry.key);
    }
  }
};

export const patchEnv = (patch: EnvPatch) => {
  const restoreEntries = Object.entries(patch).map(([key]) => ({
    hadValue: Object.hasOwn(process.env, key),
    key,
    value: process.env[key],
  }));
  let restored = false;

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }

  return () => {
    if (restored) {
      return;
    }

    restored = true;
    restorePatch(restoreEntries);
  };
};
