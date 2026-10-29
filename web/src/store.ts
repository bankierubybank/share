// Per-browser list of recently opened groups: paints home instantly and keeps pre-0.4 (unclaimed) trips findable.
// The server's "my trips" (/api/me/groups) is the source of truth.

const KEY = "share.recentGroups";
export interface RecentGroup { id: string; name: string; currency: string; archived?: boolean; openedAt: number }

export function recentGroups(): RecentGroup[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((g) => g && typeof g.id === "string" && typeof g.name === "string") : [];
  } catch {
    return [];
  }
}

export function rememberGroup(g: { id: string; name: string; currency: string; archived?: boolean }) {
  const list = recentGroups().filter((x) => x.id !== g.id);
  list.unshift({ id: g.id, name: g.name, currency: g.currency, archived: !!g.archived, openedAt: Date.now() });
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, 20)));
  } catch {
    /* storage unavailable */
  }
}

export function forgetGroup(id: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify(recentGroups().filter((x) => x.id !== id)));
    // Offline copies (web/src/offline.ts): a trip I left or deleted must not linger on this device.
    localStorage.removeItem(`share.page:${id}`);
    localStorage.removeItem(`share.outbox:${id}`);
  } catch {
    /* storage unavailable */
  }
}
