// Settle-up reminders (v0.9, #6): a ready-to-send message for whoever owes, shared through the phone's share
// sheet (LINE, WhatsApp, …) or copied. Nothing is sent by the app itself — no email service, no third-party URL.
import { snackbar } from "./dom";
import { t } from "./i18n";

export interface Debt { from: string; to: string; amount: string }

/** One person: "Hi Ben, for “Phuket” you owe Ann ฿150.00" + PromptPay (when Ann has one) + the trip link. */
export function reminderText(trip: string, d: Debt, promptpay: string | null, url: string): string {
  return [
    t("remind.single", { trip, from: d.from, to: d.to, amount: d.amount }),
    promptpay && t("remind.promptpay", { name: d.to, id: promptpay }),
    url,
  ].filter(Boolean).join("\n");
}

/** Everyone (for the trip's group chat): one line per payment. */
export function everyoneText(trip: string, debts: Debt[], url: string): string {
  return [
    t("remind.allTitle", { trip }),
    ...debts.map((d) => `• ${t("remind.line", { from: d.from, to: d.to, amount: d.amount })}`),
    url,
  ].join("\n");
}

/** Share sheet where there is one; else clipboard; else show the text so it can be copied by hand. */
export async function shareText(title: string, text: string): Promise<"shared" | "copied" | "shown"> {
  if (navigator.share) {
    try {
      await navigator.share({ title, text });
      return "shared";
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return "shared"; // the user closed the sheet
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    snackbar(t("remind.copied"));
    return "copied";
  } catch {
    snackbar(text);
    return "shown";
  }
}
