import { presenceTable } from "./report.ts";

process.stdout.write(`${await presenceTable()}\n`);
