/**
 * KeyStore interface — abstracts secret storage for managed user accounts.
 *
 * In v1 custodial mode the API manages Stellar keypairs on behalf of users.
 * Secrets MUST NOT be stored in plaintext. This interface allows swapping:
 *   - LocalDevKeyStore: AES-256-GCM with an env master key (dev only)
 *   - KmsKeyStore: AWS KMS envelope encryption (production)
 *
 * The KMS adapter is a stub — implement it before mainnet.
 * See docs/decisions.md for the custodial wallet decision.
 */
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

export interface KeyStore {
  /** Encrypt and persist a secret for a given id. */
  store(id: string, secret: string): Promise<void>;
  /** Decrypt and return the secret for a given id, or null if not found. */
  retrieve(id: string): Promise<string | null>;
}

// ── Local dev key store ───────────────────────────────────────────────────────
// Uses AES-256-GCM with a master key from the environment.
// LOCAL DEV ONLY — never use in production.
// Production must use KmsKeyStore (stub below).

const ALGO = "aes-256-gcm";
const IV_LEN = 12;

function masterKey(): Buffer {
  const raw = process.env["KEY_STORE_MASTER_KEY"];
  if (!raw) {
    // In tests/dev, derive a fixed key from a constant. Not secure.
    // ASSUMPTION: real dev setups provide KEY_STORE_MASTER_KEY in .env.
    return Buffer.alloc(32, "holdfast-dev-key-do-not-use-prod");
  }
  const buf = Buffer.from(raw, "hex");
  if (buf.length !== 32) throw new Error("KEY_STORE_MASTER_KEY must be 32 bytes (64 hex chars)");
  return buf;
}

export class LocalDevKeyStore implements KeyStore {
  private readonly vault = new Map<string, string>();

  async store(id: string, secret: string): Promise<void> {
    const key = masterKey();
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, key, iv);
    const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Format: iv_hex:tag_hex:ciphertext_hex
    this.vault.set(id, `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`);
  }

  async retrieve(id: string): Promise<string | null> {
    const stored = this.vault.get(id);
    if (!stored) return null;
    const [ivHex, tagHex, ctHex] = stored.split(":");
    if (!ivHex || !tagHex || !ctHex) return null;
    const key = masterKey();
    const decipher = createDecipheriv(ALGO, key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(ctHex, "hex")), decipher.final()]);
    return decrypted.toString("utf8");
  }
}

// ── KMS key store stub ────────────────────────────────────────────────────────
// TODO: implement using AWS KMS GenerateDataKey / Decrypt before mainnet.
// ASSUMPTION: envelope encryption pattern — KMS generates a data key per secret.

export class KmsKeyStore implements KeyStore {
  async store(_id: string, _secret: string): Promise<void> {
    throw new Error("KmsKeyStore is not yet implemented. Use LocalDevKeyStore in dev.");
  }
  async retrieve(_id: string): Promise<string | null> {
    throw new Error("KmsKeyStore is not yet implemented. Use LocalDevKeyStore in dev.");
  }
}

export function getKeyStore(): KeyStore {
  if (process.env["NODE_ENV"] === "production") {
    // TODO: return new KmsKeyStore() once implemented.
    throw new Error("Production key store (KMS) not yet implemented.");
  }
  return new LocalDevKeyStore();
}
