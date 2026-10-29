// Offline bill entry (v0.9, #8). Two small per-trip stores in localStorage:
// - outbox: new bills saved while the network was down, sent again (with their clientRef, so a retry can't add a
//   bill twice) when the connection is back;
// - page: the last trip page the server sent, shown when the trip is opened offline.
// store.ts → forgetGroup removes both when a trip is deleted or I lose access to it.
import type { Bill, BillInput } from "./api";

export interface Queued {
  /**
   * create (default, pre-0.11 entries have no `op`): retry key sent as clientRef, also the temporary bill id
   * ("tmp-" + ref) shown meanwhile. update / delete (v0.11): the bill id — a later change to it replaces this one.
   */
  ref: string;
  op?: "create" | "update" | "delete";
  /** create / update: what to send. */
  input?: BillInput;
  /** update: the bill's updatedAt it was based on — the server refuses it (409 stale) if someone changed it since. */
  base?: string;
  /** What the list shows until it syncs (delete: the bill being removed). */
  shown: Bill;
  queuedAt: string;
}

const outboxKey = (gid: string) => `share.outbox:${gid}`;
const pageKey = (gid: string) => `share.page:${gid}`;

function read<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false; // storage full or blocked
  }
}

export function queued(gid: string): Queued[] {
  const v = read<Queued[]>(outboxKey(gid));
  return Array.isArray(v) ? v.filter((q) => q && typeof q.ref === "string" && q.shown && (q.op === "delete" || q.input)) : [];
}

/** False when it couldn't be stored (then the caller treats the save as failed). */
export function enqueue(gid: string, q: Queued): boolean {
  return write(outboxKey(gid), [...queued(gid).filter((x) => x.ref !== q.ref), q]);
}

export function dequeue(gid: string, ref: string) {
  const rest = queued(gid).filter((x) => x.ref !== ref);
  if (rest.length) write(outboxKey(gid), rest);
  else {
    try { localStorage.removeItem(outboxKey(gid)); } catch { /* ignore */ }
  }
}

export function savePage<T>(gid: string, page: T) {
  write(pageKey(gid), { savedAt: new Date().toISOString(), page });
}

export function loadPage<T>(gid: string): { savedAt: string; page: T } | null {
  return read<{ savedAt: string; page: T }>(pageKey(gid));
}
