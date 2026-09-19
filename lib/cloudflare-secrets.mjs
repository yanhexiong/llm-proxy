import { randomBytes } from "node:crypto";

export const ADMIN_USERNAME_SECRET = "ADMIN_USERNAME";
export const ADMIN_PASSWORD_SECRET = "ADMIN_PASSWORD";
export const ADMIN_PASSWORD_HASH_SECRET = "ADMIN_PASSWORD_HASH";
export const LINK_SIGNING_SECRET = "LINK_SIGNING_SECRET";

export const RUNTIME_SECRET_NAMES = [
  ADMIN_USERNAME_SECRET,
  ADMIN_PASSWORD_SECRET,
  ADMIN_PASSWORD_HASH_SECRET,
  LINK_SIGNING_SECRET,
];

function asNameSet(names) {
  return names instanceof Set ? names : new Set(names || []);
}

export function hasAdminCredential(names) {
  const set = asNameSet(names);
  return (
    set.has(ADMIN_PASSWORD_SECRET) || set.has(ADMIN_PASSWORD_HASH_SECRET)
  );
}

export function missingCredentialSecretNames(names) {
  const set = asNameSet(names);
  const missing = [];
  if (!set.has(ADMIN_USERNAME_SECRET)) missing.push(ADMIN_USERNAME_SECRET);
  if (!hasAdminCredential(set)) {
    missing.push(`${ADMIN_PASSWORD_SECRET} or ${ADMIN_PASSWORD_HASH_SECRET}`);
  }
  return missing;
}

export function missingRuntimeSecretNames(names) {
  const set = asNameSet(names);
  return [
    ...missingCredentialSecretNames(set),
    ...(set.has(LINK_SIGNING_SECRET) ? [] : [LINK_SIGNING_SECRET]),
  ];
}

export function generateLinkSigningSecret() {
  return randomBytes(32).toString("base64url");
}
