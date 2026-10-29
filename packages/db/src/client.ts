/**
 * Drizzle database client.
 *
 * Import `db` for queries, `schema` for table references.
 * The connection pool is created once per process.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://holdfast:holdfast@localhost:5432/holdfast";

// One shared connection pool per process.
const pool = postgres(DATABASE_URL);

export const db = drizzle(pool, { schema });
export type Database = typeof db;
export { schema };

/** Close the pool — call in tests and graceful shutdown handlers. */
export async function closeDb(): Promise<void> {
  await pool.end();
}
