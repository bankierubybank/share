// v0.12 routes: a trip's favourite bills (#4). Registered by routes.ts on the group router (members only).
import type { Context, Hono } from "hono";
import * as v12 from "./db-v12";
import type { CustomCategory } from "./db-v11";
import { ENTITY_ID_RE } from "./lib/ids";
import { cleanName, parseBill, ValidationError } from "./lib/validate";
import type { GroupEnv } from "./routes";

export interface V12Deps {
  apiError: (c: Context, status: number, code: string, message: string) => Response;
  readJson: (c: Context) => Promise<unknown>;
}

export const TEMPLATES_PER_TRIP = 30;

const isUnique = (e: unknown) => e instanceof Error && /UNIQUE constraint failed/i.test(e.message);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const today = () => new Date().toISOString().slice(0, 10);

/**
 * What the app gets for each favourite: the bill normalized like a saved one (split, payers, fx…), or null when it
 * no longer fits the trip (a person or category in it was removed) — shown greyed out, only removable.
 */
export function templateView(rows: v12.TemplateRow[], memberIds: ReadonlySet<string>, currency: string, categories: CustomCategory[]) {
  const customIds = new Set(categories.map((c) => c.id));
  return rows.map(({ id, name, template }) => {
    let bill = null;
    try {
      const b = parseBill({ ...(JSON.parse(template) as object), date: today() }, memberIds, currency, customIds);
      const { date: _d, shares: _s, ...rest } = b;
      bill = { ...rest, paidBy: b.payers[0]?.memberId ?? null };
    } catch {
      /* stale: stays listed so it can be removed */
    }
    return { id, name, bill };
  });
}

export function registerV12(g: Hono<GroupEnv>, { apiError, readJson }: V12Deps, ctx: (c: Context<GroupEnv>) => Promise<{ memberIds: Set<string>; categories: CustomCategory[] }>) {
  const gidOf = (c: Context<GroupEnv>) => c.get("group").id;

  g.get("/templates", async (c) => {
    const [rows, { memberIds, categories }] = await Promise.all([v12.listTemplates(c.env.DB, gidOf(c)), ctx(c)]);
    return c.json({ templates: templateView(rows, memberIds, c.get("group").currency, categories) });
  });

  g.post("/templates", async (c) => {
    const body = await readJson(c);
    if (!isObj(body)) throw new ValidationError("body must be an object");
    const name = cleanName(body.name, "name", 40);
    if (!isObj(body.bill)) throw new ValidationError("bill is required");
    const { date: _ignored, clientRef: _r, ifUpdatedAt: _u, ...template } = body.bill;
    const { memberIds, categories } = await ctx(c);
    // Same rules as a real bill (today's date stands in): a favourite that can't be saved as a bill isn't kept.
    parseBill({ ...template, date: today() }, memberIds, c.get("group").currency, new Set(categories.map((x) => x.id)));
    if ((await v12.countTemplates(c.env.DB, gidOf(c))) >= TEMPLATES_PER_TRIP)
      return apiError(c, 409, "limit", `at most ${TEMPLATES_PER_TRIP} favourites per trip`);
    try {
      const row = await v12.addTemplate(c.env.DB, gidOf(c), name, template);
      return c.json({ template: templateView([row], memberIds, c.get("group").currency, categories)[0] }, 201);
    } catch (e) {
      if (isUnique(e)) return apiError(c, 409, "conflict", "this trip already has a favourite with that name");
      throw e;
    }
  });

  g.delete("/templates/:tid", async (c) => {
    const tid = c.req.param("tid");
    if (!ENTITY_ID_RE.test(tid) || !(await v12.deleteTemplate(c.env.DB, gidOf(c), tid))) return apiError(c, 404, "not_found", "favourite not found");
    return c.body(null, 204);
  });
}
