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

// Home list prefs (v0.12, #12): pinned trips and the sort, per browser — conveniences only, never required.
const PINS = "share.pins";
const SORT = "share.tripSort";
export type TripSort = "recent" | "name" | "balance";

export function pinnedTrips(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(PINS) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function togglePin(id: string): boolean {
  const pins = pinnedTrips();
  const on = !pins.delete(id);
  if (on) pins.add(id);
  try {
    localStorage.setItem(PINS, JSON.stringify([...pins].slice(-50)));
  } catch {
    /* storage unavailable */
  }
  return on;
}

export function tripSort(): TripSort {
  try {
    const v = localStorage.getItem(SORT);
    return v === "name" || v === "balance" ? v : "recent";
  } catch {
    return "recent";
  }
}

export function setTripSort(v: TripSort) {
  try {
    localStorage.setItem(SORT, v);
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
