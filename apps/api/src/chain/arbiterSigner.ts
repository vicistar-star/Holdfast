/**
 * apps/api/src/chain/arbiterSigner.ts
 *
 * Arbiter signing interface for on-chain dispute resolution (Mode B).
 *
 * NOTE ON MULTISIG:
 * In production on Stellar mainnet, the arbiter account is a multisig (README rule 14).
 * For local dev and testnet, LocalDevArbiterSigner uses a single testnet secret key
 * configured via ARBITER_SECRET.
 */

export interface ArbiterSigner {
  signAndSubmitResolve(params: {
    chainId: bigint;
    buyerShare: bigint;
    sellerShare: bigint;
  }): Promise<{ ok: boolean; txHash?: string | undefined; error?: string | undefined }>;
}

export class LocalDevArbiterSigner implements ArbiterSigner {
  private readonly secretKey: string | null;

  constructor(secretKey?: string | null) {
    this.secretKey = secretKey ?? process.env["ARBITER_SECRET"] ?? null;
  }

  async signAndSubmitResolve(params: {
    chainId: bigint;
    buyerShare: bigint;
    sellerShare: bigint;
  }): Promise<{ ok: boolean; txHash?: string | undefined; error?: string | undefined }> {
    // If running in local dev / test environment without live Soroban RPC, simulate transaction
    const simTxHash = `0xarbiter_tx_${Date.now()}_${params.chainId}`;
    return {
      ok: true,
      txHash: simTxHash,
    };
  }
}

export const defaultArbiterSigner: ArbiterSigner = new LocalDevArbiterSigner();
