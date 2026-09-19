const encoder = new TextEncoder();

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

export async function verifyPbkdf2Password(password: string, encoded: string): Promise<boolean> {
  const [algorithm, iterationsText, saltText, expected] = encoded.split("$");
  const iterations = Number(iterationsText);
  if (
    (algorithm !== "pbkdf2_sha256" && algorithm !== "pbkdf2-sha256") ||
    !saltText ||
    !expected ||
    !Number.isSafeInteger(iterations) ||
    iterations < 100_000
  ) {
    return false;
  }
  const salt = algorithm === "pbkdf2_sha256" ? decodeBase64Url(saltText) : encoder.encode(saltText);
  if (!salt) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const actualBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256,
  );
  return constantTimeEqual(base64Url(new Uint8Array(actualBits)), expected);
}
