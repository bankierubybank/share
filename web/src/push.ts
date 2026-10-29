// Notifications (v0.11, #6): turn Web Push on/off for this browser. Lazy chunk (trip menu). iPhone/iPad: only in
// the installed app (Add to Home Screen), iOS 16.4+.
import { api } from "./api";
import { lang } from "./i18n";

const b64u = (s: string) => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (ch) => ch.charCodeAt(0));
};

export const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** "on" | "denied" (blocked in browser settings) | "unsupported" (no push here, or the server has no keys). */
export async function enablePush(): Promise<"on" | "denied" | "unsupported"> {
  if (!pushSupported()) return "unsupported";
  const { publicKey } = await api.pushKey().catch(() => ({ publicKey: "" }));
  if (!publicKey) return "unsupported";
  if ((await Notification.requestPermission()) !== "granted") return "denied";
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(publicKey) }));
  await api.subscribePush(sub.toJSON(), lang());
  return "on";
}

export async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return;
  await api.unsubscribePush(sub.endpoint).catch(() => undefined);
  await sub.unsubscribe();
}
