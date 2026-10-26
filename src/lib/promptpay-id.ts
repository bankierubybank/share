/** Normalizes a PromptPay id: 10-digit mobile (0XXXXXXXXX, +66/66 accepted), 13-digit national/tax id, 15-digit e-wallet. */
export function normalizePromptPayId(input: string): string | null {
  let s = input.replace(/[\s-]/g, "");
  if (/^\+?66\d{9}$/.test(s)) s = "0" + s.replace(/^\+?66/, "");
  return /^(\d{10}|\d{13}|\d{15})$/.test(s) && (s.length !== 10 || s.startsWith("0")) ? s : null;
}
