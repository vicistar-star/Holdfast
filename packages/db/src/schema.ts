/**
 * @holdfast/db — Drizzle schema
 *
 * Money columns are bigint (minor units). No floats anywhere.
 * order_events is append-only; the initial migration installs a trigger
 * that raises an exception on any UPDATE or DELETE.
 * webhook_events is keyed by (provider, event_id) for idempotent webhook handling.
 * reconciliation_issues and webhook_events are additions beyond the README schema;
 * documented in docs/decisions.md.
 */
import {
  pgTable,
  uuid,
  text,
  bigint,
  smallint,
  integer,
  jsonb,
  timestamp,
  serial,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ── users ─────────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  phone_e164: text("phone_e164").notNull().unique(),
  // 'buyer' | 'seller' | 'arbiter' | 'admin'  — enforced by app-level Zod, not a PG enum
  // so adding a new role never requires a migration.
  role: text("role").notNull(),
  stellar_addr: text("stellar_addr").unique(),
  created_at: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── sellers ───────────────────────────────────────────────────────────────────

export const sellers = pgTable("sellers", {
  user_id: uuid("user_id")
    .primaryKey()
    .references(() => users.id),
  handle: text("handle").notNull().unique(),
  // 0 = unverified, 1/2/3 = KYC tiers from the README.
  kyc_tier: smallint("kyc_tier").notNull().default(0),
  // Provider reference only — no raw BVN/NIN/ID document data ever stored.
  kyc_ref: text("kyc_ref"),
  // Verified bank account reference from the payout partner.
  payout_ref: text("payout_ref"),
  created_at: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── payment_links ─────────────────────────────────────────────────────────────

export const payment_links = pgTable("payment_links", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  slug: text("slug").notNull().unique(),
  seller_id: uuid("seller_id")
    .notNull()
    .references(() => sellers.user_id),
  title: text("title").notNull(),
  // Money in minor units (kobo for NGN). Never float.
  amount_minor: bigint("amount_minor", { mode: "bigint" }).notNull(),
  currency: text("currency").notNull(),
  ship_by_hours: integer("ship_by_hours").notNull(),
  review_hours: integer("review_hours").notNull(),
  expires_at: timestamp("expires_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── orders ────────────────────────────────────────────────────────────────────

export const orders = pgTable("orders", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  // Null in Mode A (partner holds funds). Set to the on-chain order ID in Mode B.
  chain_id: bigint("chain_id", { mode: "bigint" }).unique(),
  link_id: uuid("link_id")
    .notNull()
    .references(() => payment_links.id),
  buyer_phone: text("buyer_phone").notNull(),
  seller_id: uuid("seller_id")
    .notNull()
    .references(() => sellers.user_id),
  // Money in minor units. Never float.
  amount_minor: bigint("amount_minor", { mode: "bigint" }).notNull(),
  currency: text("currency").notNull(),
  // Mirrors OrderStatus: Funded | Shipped | Released | Refunded | Disputed | Resolved
  status: text("status").notNull(),
  ship_by: timestamp("ship_by", { withTimezone: true }).notNull(),
  shipped_at: timestamp("shipped_at", { withTimezone: true }),
  // Computed as shipped_at + review_hours when mark_shipped is called.
  review_ends: timestamp("review_ends", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── order_events ──────────────────────────────────────────────────────────────
// Append-only. The initial migration installs a trigger that raises an exception
// on any UPDATE or DELETE attempt. Never remove that trigger.

export const order_events = pgTable("order_events", {
  id: serial("id").primaryKey(),
  order_id: uuid("order_id")
    .notNull()
    .references(() => orders.id),
  // Null for the initial 'Funded' event (no prior state).
  from_status: text("from_status"),
  to_status: text("to_status").notNull(),
  // 'buyer' | 'seller' | 'arbiter' | 'keeper' | 'system'
  actor: text("actor").notNull(),
  // On-chain transaction hash, if any (Mode B only).
  tx_hash: text("tx_hash"),
  note: jsonb("note"),
  created_at: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── evidence ──────────────────────────────────────────────────────────────────

export const evidence = pgTable("evidence", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  order_id: uuid("order_id")
    .notNull()
    .references(() => orders.id),
  uploaded_by: text("uploaded_by").notNull(),
  object_key: text("object_key").notNull(),
  // SHA-256 of the file, computed at upload time, stored as hex string.
  sha256: text("sha256").notNull(),
  created_at: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── disputes ──────────────────────────────────────────────────────────────────

export const disputes = pgTable("disputes", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  // One dispute per order (UNIQUE).
  order_id: uuid("order_id")
    .notNull()
    .unique()
    .references(() => orders.id),
  reason: text("reason").notNull(),
  opened_at: timestamp("opened_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  arbiter_id: uuid("arbiter_id").references(() => users.id),
  // Money shares in minor units. Null until the arbiter resolves.
  buyer_share: bigint("buyer_share", { mode: "bigint" }),
  seller_share: bigint("seller_share", { mode: "bigint" }),
  resolution: text("resolution"),
  resolved_at: timestamp("resolved_at", { withTimezone: true }),
});

// ── payouts ───────────────────────────────────────────────────────────────────

export const payouts = pgTable("payouts", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  order_id: uuid("order_id")
    .notNull()
    .references(() => orders.id),
  // 'seller' | 'buyer'
  party: text("party").notNull(),
  // Money in minor units. Never float.
  amount_minor: bigint("amount_minor", { mode: "bigint" }).notNull(),
  // Idempotency key sent to the payment partner. UNIQUE ensures one payout per intent.
  partner_ref: text("partner_ref").unique(),
  status: text("status").notNull(),
  created_at: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── webhook_events ────────────────────────────────────────────────────────────
// Addition beyond README schema — documented in docs/decisions.md.
// Keyed by (provider, event_id) so webhook handlers are idempotent by default.

export const webhook_events = pgTable(
  "webhook_events",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    provider: text("provider").notNull(),
    event_id: text("event_id").notNull(),
    payload: jsonb("payload").notNull(),
    // Null until the event has been fully processed.
    processed_at: timestamp("processed_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("webhook_events_provider_event_id_idx").on(
      t.provider,
      t.event_id,
    ),
  ],
);

// ── reconciliation_issues ─────────────────────────────────────────────────────
// Addition beyond README schema — documented in docs/decisions.md.
// The reconciliation job writes here when partner transactions don't match
// orders or payouts. order_id is nullable because some issues have no matching order.

export const reconciliation_issues = pgTable("reconciliation_issues", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  order_id: uuid("order_id").references(() => orders.id),
  issue_type: text("issue_type").notNull(),
  detail: jsonb("detail"),
  created_at: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── indexer_cursors ───────────────────────────────────────────────────────────
// Addition beyond README schema — documented in docs/decisions.md.
// Persists the Soroban RPC cursor and latest processed ledger for the event indexer.

export const indexer_cursors = pgTable("indexer_cursors", {
  id: text("id").primaryKey(), // e.g. "default"
  last_ledger: integer("last_ledger").notNull(),
  cursor: text("cursor"),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── notification_deliveries ───────────────────────────────────────────────────
// Addition beyond README schema — documented in docs/decisions.md.
// Tracks sent notifications to ensure idempotent delivery (no person notified twice per event).

export const notification_deliveries = pgTable(
  "notification_deliveries",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    dedup_key: text("dedup_key").notNull(),
    recipient: text("recipient").notNull(),
    channel: text("channel").notNull(), // 'whatsapp' | 'sms' | 'console' | 'email'
    template: text("template").notNull(),
    status: text("status").notNull(), // 'sent' | 'failed'
    payload: jsonb("payload"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("notification_deliveries_dedup_idx").on(t.dedup_key),
  ],
);
