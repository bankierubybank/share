#!/usr/bin/env node
// Turns a backup (backups/YYYY-MM-DD.json.gz from the "share-backups" R2 bucket) into a SQL file of INSERTs.
//
//   npx wrangler r2 object get share-backups/backups/2026-10-27.json.gz --file backup.json.gz --remote
//   node scripts/restore-backup.mjs backup.json.gz > restore.sql
//   # restore into an EMPTY database that has all migrations applied, e.g. a new one:
//   npx wrangler d1 execute <db> --remote --file restore.sql
//
// Rows are inserted parents-first (same order as BACKUP_TABLES in src/backup.ts).
import fs from "node:fs";
import zlib from "node:zlib";

const [, , input] = process.argv;
if (!input) {
  console.error("usage: node scripts/restore-backup.mjs <backup.json.gz|backup.json>");
  process.exit(1);
}
const raw = fs.readFileSync(input);
const file = JSON.parse((input.endsWith(".gz") ? zlib.gunzipSync(raw) : raw).toString("utf8"));
if (file.version !== 1) throw new Error(`unsupported backup version ${file.version}`);

const ORDER = ["groups", "members", "bills", "bill_shares", "bill_payers", "activity", "recurrences", "bill_comments", "subgroups"];
const lit = (v) =>
  v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
const ident = (s) => {
  if (!/^[a-z_]+$/.test(s)) throw new Error(`bad identifier ${s}`);
  return s;
};

const out = ["PRAGMA defer_foreign_keys = true;"];
for (const t of ORDER) {
  for (const row of file.tables[t] ?? []) {
    const cols = Object.keys(row).map(ident);
    out.push(`INSERT INTO ${ident(t)} (${cols.join(", ")}) VALUES (${cols.map((c) => lit(row[c])).join(", ")});`);
  }
}
process.stdout.write(out.join("\n") + "\n");
console.error(`-- ${out.length - 1} rows from backup created ${file.createdAt}`);
