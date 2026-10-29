// Installable app (v0.8, #11): registers the service worker (web/public/sw.js) and keeps the browser's install
// prompt so home can offer an "Install app" button where the browser supports it (Chrome/Edge/Android).
// iOS has no prompt: there it's Share → Add to Home Screen, which the manifest + apple-touch-icon support.
import { h, icon, snackbar } from "./dom";
import { t } from "./i18n";

type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };
let deferred: InstallPrompt | null = null;
const listeners = new Set<() => void>();

export function initPwa() {
  if ("serviceWorker" in navigator) {
    // Blocked in tests and some private modes: the app works the same without it.
    window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js").catch(() => undefined), { once: true });
  }
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallPrompt;
    listeners.forEach((f) => f());
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    listeners.forEach((f) => f());
    snackbar(t("pwa.installed"));
  });
}

/** App-bar button, hidden until the browser says the app can be installed. */
export function installButton(): HTMLElement {
  const btn = h("md-text-button", {
    hidden: !deferred, dataset: { testid: "pwa-install" },
    onclick: async () => {
      const p = deferred;
      if (!p) return;
      deferred = null;
      btn.hidden = true;
      await p.prompt();
      await p.userChoice.catch(() => undefined);
    },
  }, icon("download", "icon"), t("pwa.install"));
  const sync = () => {
    if (!btn.isConnected && listeners.has(sync)) return listeners.delete(sync);
    btn.hidden = !deferred;
  };
  listeners.add(sync);
  return btn;
}
