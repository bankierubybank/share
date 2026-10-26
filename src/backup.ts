// Nightly logical backup of D1 → R2 (bucket "share-backups"), gzip JSON, 30-day retention.
// Complements D1 Time Travel (point-in-time restore, 30 days) with an off-database copy.
// Restore: scripts/restore-backup.mjs → SQL file → `wrangler d1 execute --file`.

/** FK order: parents first, so a restore can insert in this order. */
export const BACKUP_TABLES = ["groups", "members", "bills", "bill_shares", "bill_payers", "activity", "recurrences", "bill_comments", "subgroups"] as const;
const PAGE = 1000;
export const BACKUP_RETENTION_DAYS = 30;

export interface BackupFile {
  version: 1;
  createdAt: string;
  tables: Record<string, Record<string, unknown>[]>;
}

async function dumpTable(db: D1Database, table: string) {
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { results } = await db.prepare(`SELECT * FROM ${table} ORDER BY rowid LIMIT ? OFFSET ?`).bind(PAGE, offset).all();
    rows.push(...(results as Record<string, unknown>[]));
    if (results.length < PAGE) return rows;
  }
}

export async function runBackup(env: Env, now = new Date()): Promise<{ key: string; rows: number }> {
  const tables: BackupFile["tables"] = {};
  let rows = 0;
  for (const t of BACKUP_TABLES) {
    tables[t] = await dumpTable(env.DB, t);
    rows += tables[t].length;
  }
  const file: BackupFile = { version: 1, createdAt: now.toISOString(), tables };
  const gz = new Response(new Blob([JSON.stringify(file)]).stream().pipeThrough(new CompressionStream("gzip")));
  const key = `backups/${now.toISOString().slice(0, 10)}.json.gz`;
  await env.BACKUPS.put(key, await gz.arrayBuffer(), {
    httpMetadata: { contentType: "application/json", contentEncoding: "gzip" },
    customMetadata: { rows: String(rows) },
  });
  await pruneBackups(env, now);
  return { key, rows };
}

async function pruneBackups(env: Env, now: Date) {
  const cutoff = new Date(now.getTime() - BACKUP_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
  const old: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.BACKUPS.list({ prefix: "backups/", cursor });
    for (const o of page.objects) if (o.key.slice(8, 18) < cutoff) old.push(o.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  if (old.length) await env.BACKUPS.delete(old);
}
