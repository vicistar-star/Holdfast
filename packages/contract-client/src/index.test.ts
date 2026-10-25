/**
 * contract-client unit tests.
 *
 * Verifies that:
 *   1. The client can be instantiated and throws correctly on bad config.
 *   2. Each build* method produces a valid base64 XDR transaction envelope
 *      that round-trips through TransactionBuilder.fromXDR without error.
 *   3. ErrorCode constants match the contract specification.
 *
 * No network calls are made — all tests are offline.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TransactionBuilder,
  Keypair,
  Networks,
  type Account,
} from "@stellar/stellar-sdk";
import { EscrowClient, createClientFromEnv, ErrorCode } from "./index.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEST_CONTRACT_ID = "CCXJ2656ZTAWW7QBZSXZFO6ZLU54I4RU2ND3Q3O454QYKVIAU3EP43B6";
const TEST_RPC_URL = "https://soroban-testnet.stellar.org";
const TEST_PASSPHRASE = Networks.TESTNET;

function makeClient(): EscrowClient {
  return new EscrowClient({
    contractId: TEST_CONTRACT_ID,
    rpcUrl: TEST_RPC_URL,
    networkPassphrase: TEST_PASSPHRASE,
  });
}

function mockAccount(keypair: Keypair): Account {
  return {
    accountId: () => keypair.publicKey(),
    sequenceNumber: () => "100",
    incrementSequenceNumber() {
      // no-op for tests
    },
  } as unknown as Account;
}

function assertValidTx(xdrStr: string, label: string) {
  const tx = TransactionBuilder.fromXDR(xdrStr, TEST_PASSPHRASE);
  assert.equal(tx.operations.length, 1, `${label}: expected 1 operation`);
  assert.equal(
    tx.operations[0]?.type,
    "invokeHostFunction",
    `${label}: expected invokeHostFunction`,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("EscrowClient", () => {
  it("instantiates from config", () => {
    const client = makeClient();
    assert.ok(client instanceof EscrowClient);
  });

  it("createClientFromEnv throws when env vars are missing", () => {
    const saved = {
      id: process.env["ESCROW_CONTRACT_ID"],
      rpc: process.env["STELLAR_RPC_URL"],
      pass: process.env["STELLAR_NETWORK_PASSPHRASE"],
    };

    delete process.env["ESCROW_CONTRACT_ID"];
    delete process.env["STELLAR_RPC_URL"];
    delete process.env["STELLAR_NETWORK_PASSPHRASE"];

    assert.throws(() => createClientFromEnv(), /Missing required env vars/);

    if (saved.id !== undefined) process.env["ESCROW_CONTRACT_ID"] = saved.id;
    if (saved.rpc !== undefined) process.env["STELLAR_RPC_URL"] = saved.rpc;
    if (saved.pass !== undefined) process.env["STELLAR_NETWORK_PASSPHRASE"] = saved.pass;
  });
});

describe("ErrorCode", () => {
  it("has correct numeric codes matching contracts/escrow/src/errors.rs", () => {
    assert.equal(ErrorCode.NotFound, 1);
    assert.equal(ErrorCode.WrongState, 2);
    assert.equal(ErrorCode.Unauthorized, 3);
    assert.equal(ErrorCode.Paused, 4);
    assert.equal(ErrorCode.AmountInvalid, 5);
    assert.equal(ErrorCode.DeadlineInvalid, 6);
    assert.equal(ErrorCode.CapExceeded, 7);
    assert.equal(ErrorCode.WindowClosed, 8);
    assert.equal(ErrorCode.WindowOpen, 9);
    assert.equal(ErrorCode.SharesMismatch, 10);
    assert.equal(ErrorCode.FeeTooHigh, 11);
    assert.equal(ErrorCode.AlreadyInitialized, 12);
    assert.equal(ErrorCode.ReviewSecsInvalid, 13);
  });
});

describe("buildMarkShipped", () => {
  it("produces a valid invokeHostFunction XDR envelope", () => {
    const client = makeClient();
    const account = mockAccount(Keypair.random());
    const xdrStr = client.buildMarkShipped(1n, account);
    assertValidTx(xdrStr, "buildMarkShipped");
  });
});

describe("buildConfirmDelivery", () => {
  it("produces a valid invokeHostFunction XDR envelope", () => {
    const client = makeClient();
    const account = mockAccount(Keypair.random());
    const xdrStr = client.buildConfirmDelivery(1n, account);
    assertValidTx(xdrStr, "buildConfirmDelivery");
  });
});

describe("buildClaimAutoRelease", () => {
  it("produces a valid invokeHostFunction XDR envelope", () => {
    const client = makeClient();
    const account = mockAccount(Keypair.random());
    const xdrStr = client.buildClaimAutoRelease(1n, account);
    assertValidTx(xdrStr, "buildClaimAutoRelease");
  });
});

describe("buildClaimRefund", () => {
  it("produces a valid invokeHostFunction XDR envelope", () => {
    const client = makeClient();
    const account = mockAccount(Keypair.random());
    const xdrStr = client.buildClaimRefund(1n, account);
    assertValidTx(xdrStr, "buildClaimRefund");
  });
});

describe("buildOpenDispute", () => {
  it("produces a valid invokeHostFunction XDR envelope", () => {
    const client = makeClient();
    const account = mockAccount(Keypair.random());
    const xdrStr = client.buildOpenDispute(1n, account);
    assertValidTx(xdrStr, "buildOpenDispute");
  });
});

describe("buildResolveDispute", () => {
  it("produces a valid invokeHostFunction XDR envelope", () => {
    const client = makeClient();
    const account = mockAccount(Keypair.random());
    const xdrStr = client.buildResolveDispute(
      { id: 1n, buyerShare: 500_000n, sellerShare: 500_000n },
      account,
    );
    assertValidTx(xdrStr, "buildResolveDispute");
  });
});

describe("buildCreateAndFund", () => {
  it("produces a valid invokeHostFunction XDR envelope", () => {
    const client = makeClient();
    const buyer = Keypair.random();
    const seller = Keypair.random();
    const account = mockAccount(buyer);

    const xdrStr = client.buildCreateAndFund(
      {
        buyer: buyer.publicKey(),
        seller: seller.publicKey(),
        token: TEST_CONTRACT_ID,
        amount: 1_000_000n,
        shipBy: BigInt(Math.floor(Date.now() / 1000) + 3 * 24 * 3600),
        reviewSecs: 48n * 3600n,
      },
      account,
    );
    assertValidTx(xdrStr, "buildCreateAndFund");
  });
});
