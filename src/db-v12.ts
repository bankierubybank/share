// D1 access for v0.12: a trip's favourite bills (#4). Everything takes the group id.
import { entityId } from "./lib/ids";

export interface TemplateRow { id: string; name: string; template: string }

export const templatesStatement = (db: D1Database, gid: string) =>
  db.prepare("SELECT id, name, template FROM bill_templates WHERE group_id = ? ORDER BY created_at, id").bind(gid);

export async function listTemplates(db: D1Database, gid: string): Promise<TemplateRow[]> {
  return (await templatesStatement(db, gid).all<TemplateRow>()).results;
}

export async function countTemplates(db: D1Database, gid: string): Promise<number> {
  return (await db.prepare("SELECT COUNT(*) n FROM bill_templates WHERE group_id = ?").bind(gid).first<{ n: number }>())?.n ?? 0;
}

/** Throws on a duplicate name (UNIQUE). */
export async function addTemplate(db: D1Database, gid: string, name: string, template: unknown): Promise<TemplateRow> {
  const row = { id: entityId(), name, template: JSON.stringify(template) };
  await db.prepare("INSERT INTO bill_templates (id, group_id, name, template) VALUES (?, ?, ?, ?)").bind(row.id, gid, name, row.template).run();
  return row;
}

export async function deleteTemplate(db: D1Database, gid: string, tid: string): Promise<boolean> {
  return (await db.prepare("DELETE FROM bill_templates WHERE id = ? AND group_id = ?").bind(tid, gid).run()).meta.changes > 0;
}
