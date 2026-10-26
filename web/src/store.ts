// Per-browser list of recently opened groups (convenience only; server is source of truth).

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
  } catch {
    /* storage unavailable */
  }
}
