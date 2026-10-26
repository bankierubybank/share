// Thai PromptPay (EMVCo merchant-presented) QR payload.

import { normalizePromptPayId } from "../../src/lib/promptpay-id";

export { normalizePromptPayId };

function tlv(tag: string, value: string): string {
  return tag + String(value.length).padStart(2, "0") + value;
}

/** CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, xorout 0. */
export function crc16(text: string): number {
  let crc = 0xffff;
  for (let i = 0; i < text.length; i++) {
    crc ^= (text.charCodeAt(i) & 0xff) << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function formatAmount(minor: number): string {
  const s = String(minor).padStart(3, "0");
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}

export function promptPayPayload(id: string, amountMinor?: number): string {
  const norm = normalizePromptPayId(id);
  if (!norm) throw new Error("Invalid PromptPay ID");
  const hasAmount = amountMinor !== undefined && amountMinor > 0;
  if (hasAmount && !Number.isSafeInteger(amountMinor)) throw new Error("Invalid amount");
  const target =
    norm.length === 10 ? tlv("01", "0066" + norm.slice(1)) : norm.length === 13 ? tlv("02", norm) : tlv("03", norm);
  let out =
    tlv("00", "01") +
    tlv("01", hasAmount ? "12" : "11") +
    tlv("29", tlv("00", "A000000677010111") + target) +
    tlv("58", "TH") +
    tlv("53", "764");
  if (hasAmount) out += tlv("54", formatAmount(amountMinor));
  out += "6304";
  return out + crc16(out).toString(16).toUpperCase().padStart(4, "0");
}

export async function renderQr(canvas: HTMLCanvasElement, text: string): Promise<void> {
  const QRCode = await import("qrcode");
  await QRCode.toCanvas(canvas, text, { errorCorrectionLevel: "M", margin: 2, width: 240 });
}
