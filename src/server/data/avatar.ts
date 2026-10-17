/**
 * Profile pictures are stored on the user as a small image data URL. The app
 * resizes and compresses the picture before upload; this checks what arrives.
 *
 * Accepted: PNG, JPEG or WebP, base64, at most AVATAR_MAX_BYTES once decoded,
 * and the bytes must start with that format's signature, so a renamed file of
 * another kind is refused.
 */

export const AVATAR_MAX_BYTES = 100 * 1024;

/** Longest acceptable data URL: the base64 of AVATAR_MAX_BYTES plus the longest prefix. */
export const AVATAR_MAX_LENGTH = Math.ceil(AVATAR_MAX_BYTES / 3) * 4 + "data:image/jpeg;base64,".length;

const DATA_URL = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

function hasSignature(type: string, bytes: Buffer): boolean {
  if (type === "png") return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (type === "jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP";
}

/** Null when the value is an acceptable avatar; otherwise a message for the person. */
export function avatarProblem(value: string): string | null {
  if (value.length > AVATAR_MAX_LENGTH) return "Profile picture is too large. Use one under 100 KB.";
  const [, type, data] = DATA_URL.exec(value) ?? [];
  if (!type || !data) return "Profile picture must be a PNG, JPEG or WebP image.";
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > AVATAR_MAX_BYTES) return "Profile picture is too large. Use one under 100 KB.";
  if (!hasSignature(type, bytes)) return "That file isn't a valid image.";
  return null;
}
