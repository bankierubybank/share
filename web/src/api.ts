// Typed client for the Worker API (see docs/API.md).

/** `budget`: optional spending target for the trip, minor units of `currency` (v0.9). Trip dates (v0.11): YYYY-MM-DD. */
export interface Group {
  id: string; name: string; currency: string; archived: boolean; createdAt: string; budget: number | null;
  startDate: string | null; endDate: string | null;
}
/** `email`: linked identity — who may open the trip as this person (null = nobody). */
export interface Member { id: string; name: string; promptpay: string | null; email: string | null }
/** A trip I'm linked to (home list). */
export interface MyGroup extends Group { memberId: string; memberName: string }
export interface Share { memberId: string; amount: number }
export type BillKind = "expense" | "payment";
export type Category = "food" | "groceries" | "lodging" | "transport" | "activities" | "shopping" | "utilities" | "other";
/** A bill's category: built-in, or "c:<id>" = one of the trip's own (v0.11). */
export type BillCategory = Category | `c:${string}`;
/** A trip's own category (v0.11); `icon` is one of CUSTOM_ICONS (web/src/categories.ts). */
export interface CustomCategory { id: string; name: string; icon: string }
/** What a receipt photo says (v0.11, Workers AI) — a suggestion to check, every field optional. */
export interface ReceiptScan {
  description?: string; amount?: number; date?: string; category?: Category;
  /** The receipt is in another currency: its total, for the fx fields. */
  fx?: { currency: string; amount: number };
  items?: { description: string; amount: number }[];
}
/** Someone from my other trips (v0.11): email suggestions when adding people. */
export interface Contact { email: string; name: string }
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
  category: BillCategory; splitMode: SplitMode; split: Split; shares: Share[]; fx: Fx | null; hasReceipt: boolean;
  recurrenceId: string | null; createdBy: string | null; createdAt: string; updatedAt: string; commentCount: number;
}
export interface Comment { id: string; billId: string; authorMemberId: string | null; actor: string | null; body: string; createdAt: string }
export interface Subgroup { id: string; name: string; memberIds: string[] }
/** Read-only snapshot from a view link: no group id (the edit secret), trimmed fields. */
export interface ViewSnapshot {
  group: Omit<Group, "id">;
  members: Omit<Member, "promptpay" | "email">[];
  bills: Omit<Bill, "createdBy" | "hasReceipt" | "recurrenceId">[];
  summary: Summary;
  /** v0.11: the trip's own categories (names + icons). */
  categories?: CustomCategory[];
  readOnly: true;
}
export interface TripPosition { groupId: string; paid: number; owed: number; net: number; total: number; bills: number }
export interface Overview { trips: TripPosition[]; months: { month: string; currency: string; owed: number }[] }
export interface InviteStatus { active: boolean; expiresAt: string | null }
/** GET /join/:token — names only; `groupId` only once the caller is in the trip. */
export type JoinInfo =
  | { joined: true; groupId: string; me: string; group: { name: string; currency: string; archived: boolean } }
  | { joined: false; group: { name: string; currency: string; archived: boolean }; members: { id: string; name: string; taken: boolean }[]; expiresAt: string };
export interface BillInput {
  kind: BillKind; description: string; amount?: number; date: string; category: BillCategory; split: Split;
  paidBy?: string; payers?: Share[]; fx?: Fx;
}
export interface Balance { memberId: string; paid: number; owed: number; net: number }
export interface Settlement { from: string; to: string; amount: number }
export interface Summary { balances: Balance[]; settlements: Settlement[]; total: number; byCategory: Partial<Record<BillCategory, number>> }
export interface Activity {
  id: string; at: string; actor: string | null; action: string; entityId: string | null;
  detail: Record<string, unknown> | null; restorable: boolean;
}
export interface Recurrence {
  id: string; frequency: "weekly" | "monthly"; nextDate: string; active: boolean; lastError: string | null;
  template: Omit<BillInput, "date">; createdBy: string | null; createdAt: string;
}

export class ApiError extends Error {
  constructor(
    public status: number, public code: string, message: string, public missing?: string[],
    /** claim_required: the trip's people, to pick who you are. */
    public members?: { id: string; name: string }[],
  ) {
    super(message);
  }
}

/** Window event: the Access session expired (main.ts shows a "sign in again" bar). */
export const SIGNED_OUT = "share:signed-out";

async function req<T>(method: string, path: string, body?: unknown, raw?: { body: Blob; type: string }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: raw ? { "Content-Type": raw.type } : body === undefined ? {} : { "Content-Type": "application/json" },
      body: raw ? raw.body : body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      // An expired Cloudflare Access session answers with a redirect to its sign-in page. Followed, that ends in a
      // CORS failure that looks exactly like being offline (and would queue bills offline); not followed, it's
      // recognizable.
      redirect: "manual",
    });
  } catch {
    throw new ApiError(0, "network", "Network error — check your connection");
  }
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400) || res.status === 401) {
    window.dispatchEvent(new Event(SIGNED_OUT));
    throw new ApiError(401, "signed_out", "Your sign-in has expired — reload the page to sign in again");
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = data?.error;
    throw new ApiError(res.status, err?.code ?? "http", err?.message ?? `Request failed (${res.status})`, err?.missing, err?.members);
  }
  return data as T;
}

const g = (gid: string) => `/groups/${encodeURIComponent(gid)}`;
const b = (gid: string, bid: string) => `${g(gid)}/bills/${encodeURIComponent(bid)}`;

export const receiptUrl = (gid: string, bid: string, v = "") => `/api${b(gid, bid)}/receipt${v ? `?v=${encodeURIComponent(v)}` : ""}`;

export const api = {
  me: () => req<{ actor: string | null }>("GET", "/me"),
  myGroups: () => req<{ groups: MyGroup[] }>("GET", "/me/groups"),
  /** My position in each trip + my share of expenses by month/currency (home). */
  overview: () => req<Overview>("GET", "/me/overview"),
  /** Opaque token that changes when the trip changes (live refresh). */
  version: (gid: string) => req<{ v: string }>("GET", `${g(gid)}/version`),
  /** `me` = index of the creator in `members`. */
  createGroup: (name: string, currency: string, members: string[], me = 0) =>
    req<{ group: Group; members: Member[]; me: string }>("POST", "/groups", { name, currency, members, me }),
  getGroup: (gid: string) => req<{ group: Group; members: Member[]; bills: Bill[]; me: string | null }>("GET", g(gid)),
  /** The whole trip page in one request (getGroup + summary + recurring + activity + subgroups + invite status). */
  groupPage: (gid: string) =>
    req<{
      group: Group; members: Member[]; bills: Bill[]; me: string | null; summary: Summary; recurring: Recurrence[];
      activity: Activity[]; subgroups: Subgroup[]; invite: InviteStatus; version: string; categories: CustomCategory[];
    }>("GET", `${g(gid)}/full`),
  /** "This is me": claim an unclaimed trip or move my link to another person. */
  setMe: (gid: string, memberId: string) => req<{ me: string }>("POST", `${g(gid)}/me`, { memberId }),
  updateGroup: (gid: string, patch: {
    name?: string; currency?: string; archived?: boolean; budget?: number | null; startDate?: string | null; endDate?: string | null;
  }) =>
    req<{ group: Group }>("PATCH", g(gid), patch),
  /** To the bin (v0.10); `forever` = gone at once, allowed only when I'm the only one linked (409 others_linked). */
  deleteGroup: (gid: string, forever = false) => req<void>("DELETE", `${g(gid)}${forever ? "?forever=1" : ""}`),
  restoreGroup: (gid: string) => req<{ group: Group }>("POST", `${g(gid)}/restore`, {}),
  /** My trips in the bin; `alone` = I may delete it for good now. */
  deletedTrips: () => req<{ trips: { id: string; name: string; currency: string; deletedAt: string; purgeAt: string; alone: boolean }[] }>("GET", "/me/deleted"),
  addMember: (gid: string, name: string, promptpay?: string | null, email?: string | null) =>
    req<{ member: Member }>("POST", `${g(gid)}/members`, { name, ...(promptpay ? { promptpay } : {}), ...(email ? { email } : {}) }),
  updateMember: (gid: string, mid: string, patch: { name?: string; promptpay?: string | null; email?: string | null }) =>
    req<{ member: Member }>("PATCH", `${g(gid)}/members/${encodeURIComponent(mid)}`, patch),
  deleteMember: (gid: string, mid: string) => req<void>("DELETE", `${g(gid)}/members/${encodeURIComponent(mid)}`),
  /** `clientRef`: retry-safe key (offline queue) — sending the same one again returns the first bill. */
  createBill: (gid: string, bill: BillInput & { clientRef?: string }) => req<{ bill: Bill; replayed?: true }>("POST", `${g(gid)}/bills`, bill),
  /** `ifUpdatedAt` (offline queue, v0.11): only if nobody changed it since → else 409 `stale`. */
  updateBill: (gid: string, bid: string, bill: BillInput & { ifUpdatedAt?: string }) => req<{ bill: Bill }>("PUT", b(gid, bid), bill),
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
  comments: (gid: string, bid: string) => req<{ comments: Comment[] }>("GET", `${b(gid, bid)}/comments`),
  /** Posted as the signed-in person (v0.10). */
  addComment: (gid: string, bid: string, body: string) => req<{ comment: Comment }>("POST", `${b(gid, bid)}/comments`, { body }),
  deleteComment: (gid: string, bid: string, cid: string) => req<void>("DELETE", `${b(gid, bid)}/comments/${encodeURIComponent(cid)}`),
  subgroups: (gid: string) => req<{ subgroups: Subgroup[] }>("GET", `${g(gid)}/subgroups`),
  saveSubgroup: (gid: string, sub: { id?: string; name: string; memberIds: string[] }) =>
    sub.id
      ? req<{ subgroup: Subgroup }>("PUT", `${g(gid)}/subgroups/${encodeURIComponent(sub.id)}`, { name: sub.name, memberIds: sub.memberIds })
      : req<{ subgroup: Subgroup }>("POST", `${g(gid)}/subgroups`, { name: sub.name, memberIds: sub.memberIds }),
  deleteSubgroup: (gid: string, sid: string) => req<void>("DELETE", `${g(gid)}/subgroups/${encodeURIComponent(sid)}`),
  viewLink: (gid: string) => req<{ viewId: string | null }>("GET", `${g(gid)}/view-link`),
  createViewLink: (gid: string) => req<{ viewId: string }>("POST", `${g(gid)}/view-link`, {}),
  revokeViewLink: (gid: string) => req<void>("DELETE", `${g(gid)}/view-link`),
  saveCategory: (gid: string, cat: { id?: string; name: string; icon: string }) =>
    cat.id
      ? req<{ category: CustomCategory }>("PATCH", `${g(gid)}/categories/${encodeURIComponent(cat.id)}`, { name: cat.name, icon: cat.icon })
      : req<{ category: CustomCategory }>("POST", `${g(gid)}/categories`, { name: cat.name, icon: cat.icon }),
  deleteCategory: (gid: string, cid: string) => req<void>("DELETE", `${g(gid)}/categories/${encodeURIComponent(cid)}`),
  /** Receipt photo → suggested bill fields (Workers AI). */
  scanReceipt: (gid: string, image: Blob) =>
    req<{ scan: ReceiptScan }>("POST", `${g(gid)}/scan`, undefined, { body: image, type: image.type || "image/jpeg" }),
  contacts: () => req<{ contacts: Contact[] }>("GET", "/me/contacts"),
  /** Web Push (v0.11): the server's VAPID public key; 404 when push isn't set up. */
  pushKey: () => req<{ publicKey: string }>("GET", "/push/key"),
  subscribePush: (sub: PushSubscriptionJSON, lang: string) => req<{ ok: true }>("POST", "/me/push", { ...sub, lang }),
  unsubscribePush: (endpoint: string) => req<void>("DELETE", "/me/push", { endpoint }),
  inviteStatus: (gid: string) => req<InviteStatus>("GET", `${g(gid)}/invite`),
  createInvite: (gid: string) => req<{ token: string; expiresAt: string }>("POST", `${g(gid)}/invite`, {}),
  revokeInvite: (gid: string) => req<void>("DELETE", `${g(gid)}/invite`),
  joinInfo: (token: string) => req<JoinInfo>("GET", `/join/${encodeURIComponent(token)}`),
  join: (token: string, who: { memberId: string } | { name: string }) =>
    req<{ groupId: string; me: string }>("POST", `/join/${encodeURIComponent(token)}`, who),
  view: (vid: string) => req<ViewSnapshot>("GET", `/view/${encodeURIComponent(vid)}`),
  moveBill: (gid: string, bid: string, targetGroupId: string, addMissingMembers = false) =>
    req<{ bill: Bill; targetGroupId: string; addedMembers: string[] }>("POST", `${b(gid, bid)}/move`, { targetGroupId, addMissingMembers }),
  merge: (gid: string, sourceGroupId: string, addMissingMembers = false) =>
    req<{ moved: number; addedMembers: string[]; sourceArchived: boolean }>("POST", `${g(gid)}/merge`, { sourceGroupId, addMissingMembers }),
};

/** Accepts a pasted group link (…/g/<id>) or a bare id. */
export function parseGroupRef(input: string): string | null {
  const m = input.trim().match(/(?:\/g\/)?([A-Za-z0-9_-]{22})(?:[/?#].*)?$/);
  return m ? m[1] : null;
}
