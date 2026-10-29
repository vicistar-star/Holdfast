/**
 * apps/api/src/storage/s3Client.test.ts
 *
 * Tests for streaming S3 evidence storage client:
 * 1. Computes SHA-256 server-side during stream.
 * 2. Enforces content-type allowlist.
 * 3. Enforces maximum size limits.
 * 4. Verification re-reads stored object and verifies hash.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { StorageService } from "./s3Client.ts";
import path from "node:path";
import os from "node:os";

describe("StorageService (S3-compatible evidence storage)", () => {
  const tmpDir = path.join(os.tmpdir(), `holdfast-evidence-test-${Date.now()}`);
  const storage = new StorageService({ localStorageDir: tmpDir });

  it("streams file to storage and computes exact SHA-256 on the fly", async () => {
    const payload = Buffer.from("Hello Holdfast Evidence Proof! A real dispute screenshot.");
    const expectedHash = crypto.createHash("sha256").update(payload).digest("hex");

    const stream = Readable.from(payload);
    const result = await storage.uploadStream({
      objectKey: "orders/test-1/proof.png",
      stream,
      contentType: "image/png",
    });

    assert.equal(result.objectKey, "orders/test-1/proof.png");
    assert.equal(result.sha256, expectedHash);
    assert.equal(result.sizeBytes, payload.length);
    assert.equal(result.contentType, "image/png");

    // Verify object hash using verifyObjectHash
    const verifyResult = await storage.verifyObjectHash("orders/test-1/proof.png", expectedHash);
    assert.equal(verifyResult.matches, true);
    assert.equal(verifyResult.calculatedSha256, expectedHash);
  });

  it("detects tampered or mismatched hash during verification", async () => {
    const wrongHash = "0000000000000000000000000000000000000000000000000000000000000000";
    const verifyResult = await storage.verifyObjectHash("orders/test-1/proof.png", wrongHash);

    assert.equal(verifyResult.matches, false);
    assert.notEqual(verifyResult.calculatedSha256, wrongHash);
  });

  it("enforces content-type allowlist", async () => {
    const stream = Readable.from(Buffer.from("malicious script"));
    await assert.rejects(
      async () => {
        await storage.uploadStream({
          objectKey: "orders/test-1/bad.exe",
          stream,
          contentType: "application/x-msdownload",
        });
      },
      {
        message: /Unsupported evidence content-type/,
      },
    );
  });

  it("enforces maximum size limit and aborts", async () => {
    // 2 KB file with a 1 KB limit
    const bigPayload = Buffer.alloc(2048, "a");
    const stream = Readable.from(bigPayload);

    await assert.rejects(
      async () => {
        await storage.uploadStream({
          objectKey: "orders/test-1/toolarge.jpg",
          stream,
          contentType: "image/jpeg",
          maxSizeBytes: 1024,
        });
      },
      /exceeds maximum size of 1024 bytes/,
    );
  });
});
