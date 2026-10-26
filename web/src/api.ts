// Typed client for the Worker API (see docs/API.md).

export interface Group { id: string; name: string; currency: string; archived: boolean; createdAt: string }
export interface Member { id: string; name: string; promptpay: string | null }
export interface Share { memberId: string; amount: number }
export type BillKind = "expense" | "payment";
export type Category = "food" | "groceries" | "lodging" | "transport" | "activities" | "shopping" | "utilities" | "other";
export interface Item { description: string; amount: number; members: string[] }
export type Split =
  | { mode: "equal"; members: string[] }
  | { mode: "exact"; shares: Share[] }
  | { mode: "shares"; weights: { memberId: string; weight: number }[] }
  | { mode: "percent"; percents: { memberId: string; bp: number }[] }
  | { mode: "itemized"; items: Item[]; serviceBp: number; taxBp: number };
export type SplitMode = Split["mode"];
export interface Fx { currency: string; amount: number; rate: string }
export interface Bill {
  id: string; kind: BillKind; description: string; amount: number; paidBy: string; payers: Share[]; date: string;
  category: Category; splitMode: SplitMode; split: Split; shares: Share[]; fx: Fx | null; hasReceipt: boolean;
  recurrenceId: string | null; createdBy: string | null; createdAt: string; updatedAt: string;
}
export interface BillInput {
  kind: BillKind; description: string; amount?: number; date: string; category: Category; split: Split;
  paidBy?: string; payers?: Share[]; fx?: Fx;
}
export interface Balance { memberId: string; paid: number; owed: number; net: number }
export interface Settlement { from: string; to: string; amount: number }
export interface Summary { balances: Balance[]; settlements: Settlement[]; total: number; byCategory: Partial<Record<Category, number>> }
export interface Activity {
  id: string; at: string; actor: string | null; action: string; entityId: string | null;
  detail: Record<string, unknown> | null; restorable: boolean;
}
export interface Recurrence {
  id: string; frequency: "weekly" | "monthly"; nextDate: string; active: boolean; lastError: string | null;
  template: Omit<BillInput, "date">; createdBy: string | null; createdAt: string;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function req<T>(method: string, path: string, body?: unknown, raw?: { body: Blob; type: string }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: raw ? { "Content-Type": raw.type } : body === undefined ? {} : { "Content-Type": "application/json" },
      body: raw ? raw.body : body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError(0, "network", "Network error — check your connection");
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = data?.error;
    throw new ApiError(res.status, err?.code ?? "http", err?.message ?? `Request failed (${res.status})`);
  }
  return data as T;
}

const g = (gid: string) => `/groups/${encodeURIComponent(gid)}`;
const b = (gid: string, bid: string) => `${g(gid)}/bills/${encodeURIComponent(bid)}`;

export const receiptUrl = (gid: string, bid: string, v = "") => `/api${b(gid, bid)}/receipt${v ? `?v=${encodeURIComponent(v)}` : ""}`;

export const api = {
  me: () => req<{ actor: string | null }>("GET", "/me"),
  createGroup: (name: string, currency: string, members: string[]) =>
    req<{ group: Group; members: Member[] }>("POST", "/groups", { name, currency, members }),
  getGroup: (gid: string) => req<{ group: Group; members: Member[]; bills: Bill[] }>("GET", g(gid)),
  updateGroup: (gid: string, patch: { name?: string; currency?: string; archived?: boolean }) =>
    req<{ group: Group }>("PATCH", g(gid), patch),
  deleteGroup: (gid: string) => req<void>("DELETE", g(gid)),
  addMember: (gid: string, name: string, promptpay?: string | null) =>
    req<{ member: Member }>("POST", `${g(gid)}/members`, { name, ...(promptpay ? { promptpay } : {}) }),
  updateMember: (gid: string, mid: string, patch: { name?: string; promptpay?: string | null }) =>
    req<{ member: Member }>("PATCH", `${g(gid)}/members/${encodeURIComponent(mid)}`, patch),
  deleteMember: (gid: string, mid: string) => req<void>("DELETE", `${g(gid)}/members/${encodeURIComponent(mid)}`),
  createBill: (gid: string, bill: BillInput) => req<{ bill: Bill }>("POST", `${g(gid)}/bills`, bill),
  updateBill: (gid: string, bid: string, bill: BillInput) => req<{ bill: Bill }>("PUT", b(gid, bid), bill),
  deleteBill: (gid: string, bid: string) => req<void>("DELETE", b(gid, bid)),
  // Empty JSON body on purpose: every POST must be application/json (CSRF guard in src/index.ts).
  restoreBill: (gid: string, bid: string) => req<{ bill: Bill }>("POST", `${b(gid, bid)}/restore`, {}),
  uploadReceipt: (gid: string, bid: string, blob: Blob) =>
    req<{ ok: true }>("PUT", `${b(gid, bid)}/receipt`, undefined, { body: blob, type: blob.type || "image/jpeg" }),
  deleteReceipt: (gid: string, bid: string) => req<void>("DELETE", `${b(gid, bid)}/receipt`),
  summary: (gid: string) => req<Summary>("GET", `${g(gid)}/summary`),
  activity: (gid: string, before?: string) =>
    req<{ activity: Activity[] }>("GET", `${g(gid)}/activity?limit=50${before ? `&before=${encodeURIComponent(before)}` : ""}`),
  recurring: (gid: string) => req<{ recurring: Recurrence[] }>("GET", `${g(gid)}/recurring`),
  createRecurring: (gid: string, frequency: "weekly" | "monthly", startDate: string, bill: Omit<BillInput, "date">) =>
    req<{ recurring: Recurrence; created: number }>("POST", `${g(gid)}/recurring`, { frequency, startDate, bill }),
  stopRecurring: (gid: string, rid: string) => req<void>("DELETE", `${g(gid)}/recurring/${encodeURIComponent(rid)}`),
};
