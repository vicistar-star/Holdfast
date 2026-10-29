/* eslint-disable no-console */
/**
 * apps/api/src/cli/verifyEvidence.ts
 *
 * Evidence verification CLI.
 *
 * Usage:
 *   pnpm --filter @holdfast/api evidence:verify <object_key_or_evidence_id>
 *
 * Re-reads stored file from S3-compatible storage, re-computes SHA-256,
 * and validates against Postgres record.
 */

import { defaultStorage } from "../storage/s3Client.ts";
import { db, schema, eq } from "@holdfast/db";

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: pnpm evidence:verify <evidence_id_or_object_key>");
    process.exit(1);
  }

  console.log(`[Evidence Verify] Looking up evidence record for "${target}"...`);

  let record = null;

  try {
    // Try by evidence UUID
    record = await db.query.evidence.findFirst({
      where: eq(schema.evidence.id, target),
    });

    if (!record) {
      // Try by object_key
      record = await db.query.evidence.findFirst({
        where: eq(schema.evidence.object_key, target),
      });
    }
  } catch (err) {
    console.warn(`[Evidence Verify] Database lookup warning: ${(err as Error).message}`);
  }

  if (record) {
    console.log(`[Evidence Verify] Found record ID: ${record.id}`);
    console.log(`[Evidence Verify] Stored SHA-256: ${record.sha256}`);
    console.log(`[Evidence Verify] Object Key:    ${record.object_key}`);

    const res = await defaultStorage.verifyObjectHash(record.object_key, record.sha256);
    if (res.matches) {
      console.log(`\n✅ VERIFICATION SUCCESS: Stored file matches database hash exactly!`);
      console.log(`   Hash: ${res.calculatedSha256}`);
      console.log(`   Size: ${res.sizeBytes} bytes`);
      process.exit(0);
    } else {
      console.error(`\n❌ VERIFICATION FAILURE: Hash mismatch detected!`);
      console.error(`   Expected:   ${res.expectedSha256}`);
      console.error(`   Calculated: ${res.calculatedSha256}`);
      process.exit(2);
    }
  } else {
    // If not found in DB, just verify file against given hash if second arg provided
    console.log(`[Evidence Verify] No DB record found; verifying directly against storage...`);
    const expected = process.argv[3];
    if (!expected) {
      console.error(`Record not found in database and no expected SHA-256 hash was provided.`);
      process.exit(1);
    }
    const res = await defaultStorage.verifyObjectHash(target, expected);
    if (res.matches) {
      console.log(`\n✅ VERIFICATION SUCCESS: Hash matches expected ${expected}`);
      process.exit(0);
    } else {
      console.error(`\n❌ VERIFICATION FAILURE: Calculated ${res.calculatedSha256} does not match expected ${expected}`);
      process.exit(2);
    }
  }
}

main().catch((err) => {
  console.error("Fatal error during verification:", err);
  process.exit(1);
});
