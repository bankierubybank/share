import "dotenv/config";
import { config } from "dotenv";

// Loads .env.test (git-ignored) for prod runs: CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET.
config({ path: ".env.test", quiet: true });

// TARGET_URL, not BASE_URL: Vitest/Vite reserves BASE_URL (forces "/").
export const BASE_URL = (process.env.TARGET_URL ?? "http://localhost:8787").replace(/\/$/, "");

/** Cloudflare Access service-token headers, if configured. */
export function accessHeaders(): Record<string, string> {
  const id = process.env.CF_ACCESS_CLIENT_ID;
  const secret = process.env.CF_ACCESS_CLIENT_SECRET;
  return id && secret ? { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret } : {};
}

/** Ids of every group created through api()/makeGroup in this process; removed by cleanupGroups(). */
export const createdGroups: string[] = [];

export async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    redirect: "manual",
    headers: {
      ...accessHeaders(),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    /* non-JSON */
  }
  if (method === "POST" && path === "/api/groups" && res.status === 201 && json?.group?.id) createdGroups.push(json.group.id);
  return { status: res.status, headers: res.headers, json, text };
}

/** Raw-bytes request (receipt upload/download). Returns the body as bytes. */
export async function apiBytes(method: string, path: string, body?: Uint8Array, contentType?: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    redirect: "manual",
    headers: { ...accessHeaders(), ...(contentType ? { "Content-Type": contentType } : {}), ...headers },
    body: body as BodyInit | undefined,
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  let json: any = undefined;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    /* binary / non-JSON */
  }
  return { status: res.status, headers: res.headers, bytes, json, text: json ? new TextDecoder().decode(bytes) : "" };
}

/** Hard-deletes a group (and its receipts): `forever` — tests act alone in their trips (v0.10). */
export async function deleteGroup(gid: string) {
  return api("DELETE", `/api/groups/${gid}?forever=1`);
}

/** Deletes every group created in this process (call from afterAll). Never throws. */
export async function cleanupGroups() {
  const ids = createdGroups.splice(0);
  for (let i = 0; i < ids.length; i += 8) {
    await Promise.all(ids.slice(i, i + 8).map((gid) => deleteGroup(gid).catch(() => undefined)));
  }
}

export const today = () => new Date().toISOString().slice(0, 10);

/** Creates a group with given member names; returns ids by name. */
export async function makeGroup(names = ["Alice", "Bob", "Carol"], currency = "USD") {
  const r = await api("POST", "/api/groups", { name: `Test ${Date.now()}`, currency, members: names });
  if (r.status !== 201) throw new Error(`makeGroup failed ${r.status} ${r.text}`);
  const ids: Record<string, string> = {};
  for (const m of r.json.members) ids[m.name] = m.id;
  return { gid: r.json.group.id as string, ids, members: r.json.members as { id: string; name: string }[] };
}
