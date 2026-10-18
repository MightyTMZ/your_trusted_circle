import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";

/** Server-side ids. ses_/par_ match the timeline's id format (src/shared/ids.ts). */
export const newId = (prefix: "usr" | "ses" | "par" | "trc" | "chk" | "inc" | "ntf" | "con" | "esc" | "call") => `${prefix}_${randomUUID()}`;

/** No 0/O or 1/I, so codes read cleanly off a screen. Matches the client's #join=XXXXXX link. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function newJoinCode(): string {
  let code = "";
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

export function normalizeJoinCode(input: string): string | null {
  const code = input.trim().toUpperCase();
  return /^[A-Z0-9]{6}$/.test(code) ? code : null;
}

/** 256-bit bearer secret for the session cookie. */
export const newToken = () => randomBytes(32).toString("base64url");

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
