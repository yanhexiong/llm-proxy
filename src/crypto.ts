const encoder = new TextEncoder();

const MIN_ADMIN_PASSWORD_CHARACTERS = 8;

export interface AdminPasswordBindings {
  ADMIN_PASSWORD?: unknown;
  ADMIN_PASSWORD_HASH?: unknown;
}

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return base64Url(new Uint8Array(digest));
}

export function randomToken(size = 32): string {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return base64Url(new Uint8Array(signature));
}

export function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function parsePbkdf2PasswordHash(encoded: unknown): {
  salt: Uint8Array<ArrayBuffer>;
  expected: string;
  iterations: number;
} | null {
  if (typeof encoded !== "string") return null;
  const fields = encoded.split("$");
  if (fields.length !== 4) return null;
  const [algorithm, iterationsText, saltText, expected] = fields;
  const iterations = Number(iterationsText);
  if (
    (algorithm !== "pbkdf2_sha256" && algorithm !== "pbkdf2-sha256") ||
    !saltText ||
    !expected ||
    !Number.isSafeInteger(iterations) ||
    iterations < 100_000
  ) {
    return null;
  }
  const salt = algorithm === "pbkdf2_sha256" ? decodeBase64Url(saltText) : encoder.encode(saltText);
  const expectedBytes = expected ? decodeBase64Url(expected) : null;
  // PBKDF2-SHA-256 emits exactly 32 bytes. Reject malformed values before any
  // expensive derivation and keep health checks from accepting unusable hashes.
  if (!salt || salt.byteLength === 0 || !expectedBytes || expectedBytes.byteLength !== 32) return null;
  return { salt, expected, iterations };
}

export function isValidAdminPassword(password: unknown): password is string {
  return typeof password === "string" && Array.from(password).length >= MIN_ADMIN_PASSWORD_CHARACTERS;
}

export function isValidPbkdf2PasswordHash(encoded: unknown): encoded is string {
  return parsePbkdf2PasswordHash(encoded) !== null;
}

export async function verifyPbkdf2Password(password: string, encoded: unknown): Promise<boolean> {
  const parsed = parsePbkdf2PasswordHash(encoded);
  if (!parsed) return false;
  const { salt, iterations, expected } = parsed;
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const actualBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256,
  );
  return constantTimeEqual(base64Url(new Uint8Array(actualBits)), expected);
}

export function hasValidAdminPasswordConfiguration(bindings: AdminPasswordBindings): boolean {
  // An explicitly present ADMIN_PASSWORD is authoritative, including an empty
  // or weak value. Never fall back to a legacy hash in that case.
  if (bindings.ADMIN_PASSWORD !== undefined) return isValidAdminPassword(bindings.ADMIN_PASSWORD);
  return isValidPbkdf2PasswordHash(bindings.ADMIN_PASSWORD_HASH);
}

export async function verifyAdminPassword(password: string, bindings: AdminPasswordBindings): Promise<boolean> {
  if (bindings.ADMIN_PASSWORD !== undefined) {
    if (!isValidAdminPassword(bindings.ADMIN_PASSWORD)) return false;
    // Both values are SHA-256 digests with a fixed length, so the comparison
    // does not expose the configured password's length or contents.
    const [actual, expected] = await Promise.all([sha256(password), sha256(bindings.ADMIN_PASSWORD)]);
    return constantTimeEqual(actual, expected);
  }
  return verifyPbkdf2Password(password, bindings.ADMIN_PASSWORD_HASH);
}
