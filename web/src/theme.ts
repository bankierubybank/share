import { h, icon } from "./dom";
import type { IconName } from "./icons";
import { t, type TKey } from "./i18n";

// Theme choice: "system" (follow OS), "light", "dark". Applied early by /theme.js; this module toggles it.
export type Theme = "system" | "light" | "dark";
const KEY = "share.theme";
const NEXT: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
const META: Record<Theme, { icon: IconName; label: TKey }> = {
  system: { icon: "contrast", label: "theme.system" },
  light: { icon: "light_mode", label: "theme.light" },
  dark: { icon: "dark_mode", label: "theme.dark" },
};

export function currentTheme(): Theme {
  const t = document.documentElement.dataset.theme;
  return t === "light" || t === "dark" ? t : "system";
}

export function setTheme(t: Theme) {
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try {
    if (t === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch {
    /* storage unavailable: choice lasts for this page only */
  }
}

/** App-bar button cycling system → light → dark. */
export function themeButton() {
  const btn = h("md-icon-button", { dataset: { testid: "theme-toggle" } });
  const paint = () => {
    const m = META[currentTheme()];
    const label = t(m.label);
    btn.replaceChildren(icon(m.icon));
    btn.setAttribute("aria-label", t("theme.activate", { label }));
    btn.title = label;
  };
  btn.addEventListener("click", () => {
    setTheme(NEXT[currentTheme()]);
    paint();
  });
  paint();
  return btn;
}
