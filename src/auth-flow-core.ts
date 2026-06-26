import { z } from 'zod';
import type { ConnectAuthCallbackParams } from './callback-core.js';
import { normalizeReturnPath, type ReturnPathNormalizationResult } from './return-path-core.js';

export type CreateConnectLoginIntentRequest = {
  action: ConnectActionInput;
  initiatingOrigin?: string;
  returnPath: string;
  state: string;
};

export type CreateConnectIntentRequest = CreateConnectLoginIntentRequest;

export type ConnectChainId = number;

export type ConnectEthereumAddress = string;

export type ConnectExpectedPriceTerms = {
  currency: string;
  price: string;
};

export type ConnectExpectedUnitPriceTerms = {
  currency: string;
  unitPrice: string;
};

export type ConnectBidTerms = {
  currency: string;
  amount: string;
};

export type ConnectPurchaseTerms = {
  quantity: string;
  currency?: string;
  unitPrice?: string;
};

export type ConnectErc721DirectListingTarget = {
  kind: 'erc721-direct-listing';
  chainId: ConnectChainId;
  contract: ConnectEthereumAddress;
  tokenId: string;
  target?: ConnectEthereumAddress;
};

export type ConnectErc721BatchListingTarget = {
  kind: 'erc721-batch-listing';
  chainId: ConnectChainId;
  creator: ConnectEthereumAddress;
  root: string;
  contract: ConnectEthereumAddress;
  tokenId: string;
};

export type ConnectErc1155ListingTarget = {
  kind: 'erc1155-listing';
  chainId: ConnectChainId;
  contract: ConnectEthereumAddress;
  seller: ConnectEthereumAddress;
  tokenId: string;
  quantity: string;
};

export type ConnectErc721ReserveAuctionTarget = {
  kind: 'erc721-reserve-auction';
  chainId: ConnectChainId;
  contract: ConnectEthereumAddress;
  tokenId: string;
};

export type ConnectErc721BatchReserveAuctionTarget = {
  kind: 'erc721-batch-reserve-auction';
  chainId: ConnectChainId;
  creator: ConnectEthereumAddress;
  root: string;
  contract: ConnectEthereumAddress;
  tokenId: string;
};

export type ConnectErc721ReleaseTarget = {
  kind: 'erc721-release';
  chainId: ConnectChainId;
  contract: ConnectEthereumAddress;
};

export type ConnectErc1155ReleaseTarget = {
  kind: 'erc1155-release';
  chainId: ConnectChainId;
  contract: ConnectEthereumAddress;
  tokenId: string;
};

export type ConnectErc1155CheckoutReleaseItem = {
  kind: 'release';
  contract: ConnectEthereumAddress;
  tokenId: string;
  quantity: string;
  expected?: ConnectExpectedUnitPriceTerms;
};

export type ConnectErc1155CheckoutListingItem = {
  kind: 'listing';
  contract: ConnectEthereumAddress;
  seller: ConnectEthereumAddress;
  tokenId: string;
  quantity: string;
  expected: ConnectExpectedUnitPriceTerms;
};

export type ConnectErc1155CheckoutTarget = {
  kind: 'erc1155-checkout';
  chainId: ConnectChainId;
  items: Array<ConnectErc1155CheckoutReleaseItem | ConnectErc1155CheckoutListingItem>;
};

export type ConnectBuyTarget =
  | ConnectErc721DirectListingTarget
  | ConnectErc721BatchListingTarget
  | ConnectErc1155ListingTarget;

export type ConnectBidTarget =
  | ConnectErc721ReserveAuctionTarget
  | ConnectErc721BatchReserveAuctionTarget;

export type ConnectMintTarget =
  | ConnectErc721ReleaseTarget
  | ConnectErc1155ReleaseTarget;

export type ConnectActionInput =
  | { type: 'login' }
  | {
    type: 'buy';
    target: ConnectErc721DirectListingTarget | ConnectErc721BatchListingTarget;
    expected: ConnectExpectedPriceTerms;
  }
  | {
    type: 'buy';
    target: ConnectErc1155ListingTarget;
    expected: ConnectExpectedUnitPriceTerms;
  }
  | {
    type: 'bid';
    target: ConnectBidTarget;
    bid: ConnectBidTerms;
  }
  | {
    type: 'mint';
    target: ConnectMintTarget;
    purchase: ConnectPurchaseTerms;
  }
  | {
    type: 'checkout';
    target: ConnectErc1155CheckoutTarget;
  };

export type BuildConnectLoginIntentRequestInput = {
  returnPath?: string;
  state: string;
  initiatingOrigin?: string;
};

export type BuildConnectLoginIntentRequestResult =
  | { ok: true; request: CreateConnectLoginIntentRequest }
  | Extract<ReturnPathNormalizationResult, { ok: false }>;

export const pendingConnectAuthSchema = z.object({
  intentId: z.string().min(1),
  state: z.string().min(1),
  expiresAt: z.string().min(1),
});

export type PendingConnectAuth = z.infer<typeof pendingConnectAuthSchema>;

export type ConnectAuthPendingVerificationError =
  | 'missing_pending_auth'
  | 'intent_mismatch'
  | 'state_mismatch';

export type ConnectAuthPendingVerificationResult =
  | { ok: true }
  | { ok: false; error: ConnectAuthPendingVerificationError };

export function buildConnectLoginIntentRequest(
  input: BuildConnectLoginIntentRequestInput,
): BuildConnectLoginIntentRequestResult {
  const returnPathResult = normalizeReturnPath(input.returnPath);
  if (!returnPathResult.ok) {
    return { ok: false, error: returnPathResult.error };
  }

  return {
    ok: true,
    request: {
      action: { type: 'login' },
      returnPath: returnPathResult.returnPath,
      state: input.state,
      ...(input.initiatingOrigin === undefined ? {} : { initiatingOrigin: input.initiatingOrigin }),
    },
  };
}

export function verifyConnectAuthCallbackAgainstPending(input: {
  pendingAuth: PendingConnectAuth | undefined;
  callbackParams: ConnectAuthCallbackParams;
}): ConnectAuthPendingVerificationResult {
  if (input.pendingAuth === undefined) {
    return { ok: false, error: 'missing_pending_auth' };
  }

  if (input.pendingAuth.intentId !== input.callbackParams.intentId) {
    return { ok: false, error: 'intent_mismatch' };
  }

  if (input.pendingAuth.state !== input.callbackParams.state) {
    return { ok: false, error: 'state_mismatch' };
  }

  return { ok: true };
}

export function serializePendingConnectAuth(pendingAuth: PendingConnectAuth): string {
  return JSON.stringify(pendingAuth);
}

export function parseStoredPendingConnectAuth(serializedPendingAuth: string): PendingConnectAuth | undefined {
  const parsedPendingAuth = parseJson(serializedPendingAuth);
  const result = pendingConnectAuthSchema.safeParse(parsedPendingAuth);
  return result.success ? result.data : undefined;
}

function parseJson(value: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    return undefined;
  }
}
