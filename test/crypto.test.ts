import { describe, expect, it } from "vitest";
import { constantTimeEqual, hmac, sha256, verifyPbkdf2Password } from "../src/crypto";
import { signCredential, verifyCredential } from "../src/auth";

describe("credentials", () => {
  it("signs and verifies link IDs", async () => {
    const signed = await signCredential("link-id", "a sufficiently long test secret");
    expect(await verifyCredential(signed, "a sufficiently long test secret")).toEqual({ valid: true, id: "link-id" });
    expect((await verifyCredential(`${signed}x`, "a sufficiently long test secret")).valid).toBe(false);
  });

  it("hashes without exposing the original token", async () => {
    expect(await sha256("secret")).not.toContain("secret");
    expect(constantTimeEqual(await hmac("id", "secret"), await hmac("id", "secret"))).toBe(true);
  });

  it("verifies the hash format emitted by the setup script", async () => {
    const hash = "pbkdf2_sha256$100000$dGVzdA$W4Tnq8EZ1Jegj2ii8LuLBHIUv9UBa9FiSS-7m3lDqyI";
    expect(await verifyPbkdf2Password("test-password", hash)).toBe(true);
    expect(await verifyPbkdf2Password("wrong", hash)).toBe(false);
  });
});
