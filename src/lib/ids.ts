function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomId(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return b64url(bytes);
}

/** 128-bit group id (22 chars) — acts as the share secret. */
export const groupId = () => randomId(16);
/** 96-bit id for members/bills (16 chars). */
export const entityId = () => randomId(12);

export const GROUP_ID_RE = /^[A-Za-z0-9_-]{22}$/;
export const ENTITY_ID_RE = /^[A-Za-z0-9_-]{16}$/;
