// Typed client for the Worker API (see docs/API.md).

export interface Group { id: string; name: string; currency: string; createdAt: string }
export interface Member { id: string; name: string }
export interface Share { memberId: string; amount: number }
export type BillKind = "expense" | "payment";
export interface Bill {
  id: string; kind: BillKind; description: string; amount: number; paidBy: string; date: string;
  splitMode: "equal" | "exact"; shares: Share[]; createdAt: string;
}
export type Split = { mode: "equal"; members: string[] } | { mode: "exact"; shares: Share[] };
export interface BillInput { kind: BillKind; description: string; amount: number; paidBy: string; date: string; split: Split }
export interface Balance { memberId: string; paid: number; owed: number; net: number }
export interface Settlement { from: string; to: string; amount: number }
export interface Summary { balances: Balance[]; settlements: Settlement[]; total: number }

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
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

export const api = {
  createGroup: (name: string, currency: string, members: string[]) =>
    req<{ group: Group; members: Member[] }>("POST", "/groups", { name, currency, members }),
  getGroup: (gid: string) => req<{ group: Group; members: Member[]; bills: Bill[] }>("GET", g(gid)),
  updateGroup: (gid: string, patch: { name?: string; currency?: string }) =>
    req<{ group: Group }>("PATCH", g(gid), patch),
  addMember: (gid: string, name: string) => req<{ member: Member }>("POST", `${g(gid)}/members`, { name }),
  renameMember: (gid: string, mid: string, name: string) =>
    req<{ member: Member }>("PATCH", `${g(gid)}/members/${encodeURIComponent(mid)}`, { name }),
  deleteMember: (gid: string, mid: string) => req<void>("DELETE", `${g(gid)}/members/${encodeURIComponent(mid)}`),
  createBill: (gid: string, bill: BillInput) => req<{ bill: Bill }>("POST", `${g(gid)}/bills`, bill),
  updateBill: (gid: string, bid: string, bill: BillInput) =>
    req<{ bill: Bill }>("PUT", `${g(gid)}/bills/${encodeURIComponent(bid)}`, bill),
  deleteBill: (gid: string, bid: string) => req<void>("DELETE", `${g(gid)}/bills/${encodeURIComponent(bid)}`),
  summary: (gid: string) => req<Summary>("GET", `${g(gid)}/summary`),
};
