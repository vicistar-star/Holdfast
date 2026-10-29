/**
 * apps/worker/src/backfill.ts
 *
 * Backfill command for the Soroban RPC Event Indexer.
 * Takes a start ledger number and replays events into order_events and projection.
 *
 * Usage:
 *   node --experimental-strip-types src/backfill.ts --start-ledger 12345
 */

import { EventIndexerService, type SorobanEventSource } from "./indexer.ts";

function parseStartLedger(): number {
  const args = process.argv.slice(2);
  const flagIdx = args.indexOf("--start-ledger");
  if (flagIdx !== -1 && args[flagIdx + 1]) {
    const val = parseInt(args[flagIdx + 1]!, 10);
    if (!isNaN(val)) return val;
  }
  const pos = parseInt(args[0] ?? "", 10);
  if (!isNaN(pos)) return pos;
  return 1;
}

// Stub event source for standalone CLI invocation
const defaultEventSource: SorobanEventSource = {
  async getEvents() {
    return { events: [], latestLedger: 1 };
  },
};

export async function runBackfill(
  startLedger = parseStartLedger(),
  source: SorobanEventSource = defaultEventSource,
): Promise<{ processedCount: number }> {
  console.warn(`[Indexer] Starting backfill from ledger ${startLedger}...`);
  const indexer = new EventIndexerService(source);
  const res = await indexer.backfill(startLedger);
  console.warn(`[Indexer] Backfill complete. Processed ${res.processedCount} events.`);
  return res;
}

if (process.argv[1]?.endsWith("backfill.ts")) {
  runBackfill().catch((err: unknown) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  });
}
