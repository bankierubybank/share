import { describe, expect, it } from "vitest";
import { crc16, normalizePromptPayId, promptPayPayload } from "../../../web/src/promptpay";

describe("crc16", () => {
  it("matches CCITT-FALSE check value", () => {
    expect(crc16("123456789")).toBe(0x29b1);
  });
});

describe("normalizePromptPayId", () => {
  it.each([
    ["081-234-5678", "0812345678"],
    ["081 234 5678", "0812345678"],
    ["+66812345678", "0812345678"],
    ["66812345678", "0812345678"],
    ["+66 81-234-5678", "0812345678"],
    ["1-2345-67890-12-3", "1234567890123"],
    ["123456789012345", "123456789012345"],
  ])("%s -> %s", (input, out) => {
    expect(normalizePromptPayId(input)).toBe(out);
  });

  it.each(["", "abc", "1234567890", "081234567", "12345678901", "123456789012345678", "+6612345"])(
    "rejects %s",
    (input) => {
      expect(normalizePromptPayId(input)).toBeNull();
    },
  );
});

describe("promptPayPayload", () => {
  it("reproduces the known mobile vector (no amount)", () => {
    expect(promptPayPayload("0000000000")).toBe(
      "00020101021129370016A000000677010111011300660000000005802TH530376463048956",
    );
  });

  it("uses dynamic flag and formats amount", () => {
    const p = promptPayPayload("0812345678", 12345);
    expect(p.startsWith("000201010212")).toBe(true);
    expect(p).toContain("5303764" + "5406123.45" + "6304");
    expect(p).toContain("0113006681234567" + "8");
  });

  it("formats small amounts", () => {
    expect(promptPayPayload("0812345678", 5)).toContain("54040.05");
    expect(promptPayPayload("0812345678", 100)).toContain("54041.00");
  });

  it("omits amount when zero or absent", () => {
    expect(promptPayPayload("0812345678", 0)).toBe(promptPayPayload("0812345678"));
    expect(promptPayPayload("0812345678")).toContain("010211");
  });

  it("uses tag 02 for national ID and 03 for e-wallet", () => {
    expect(promptPayPayload("1234567890123")).toContain("A0000006770101110213" + "1234567890123");
    expect(promptPayPayload("123456789012345")).toContain("A0000006770101110315" + "123456789012345");
  });

  it("ends with a valid CRC", () => {
    const p = promptPayPayload("1234567890123", 999);
    const body = p.slice(0, -4);
    expect(p.slice(-4)).toBe(crc16(body).toString(16).toUpperCase().padStart(4, "0"));
    expect(body.endsWith("6304")).toBe(true);
  });

  it("throws on invalid id", () => {
    expect(() => promptPayPayload("12345")).toThrow();
    expect(() => promptPayPayload("")).toThrow();
  });
});
