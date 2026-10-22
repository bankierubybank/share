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
  return { status: res.status, headers: res.headers, json, text };
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
