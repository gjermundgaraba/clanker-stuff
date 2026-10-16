import { fuzzyFilter } from "@earendil-works/pi-tui";

const ARGS = [
  { value: "refresh", description: "Refetch usage instead of showing the cached snapshot" },
];

const USAGE = `usage: expected /usage [${ARGS.map((arg) => arg.value).join("|")}]`;

export const parseUsageArgs = (
  args: string,
): { ok: true; refresh: boolean } | { ok: false; message: string } => {
  const command = args.trim();

  if (command === "") {
    return { ok: true, refresh: false };
  }

  return command === "refresh" ? { ok: true, refresh: true } : { message: USAGE, ok: false };
};

export const completeUsageArgs = (prefix: string) =>
  fuzzyFilter(ARGS, prefix, (arg) => arg.value).map((arg) => ({ label: arg.value, ...arg }));
