import type { CreateConnectIntentRequest } from './auth-flow-core.js';
import { normalizeReturnPath, type ReturnPathNormalizationResult } from './return-path-core.js';

export type SellerManagerParams = {
  returnPath?: string;
  initiatingOrigin?: string;
};

export type SellerListingManagerParams = SellerManagerParams & {
  productId: string;
};

export type BuildConnectSellerIntentRequestInput = SellerManagerParams & {
  state: string;
};

export type BuildConnectSellerListingIntentRequestInput = SellerListingManagerParams & {
  state: string;
};

export type BuildConnectSellerIntentRequestResult =
  | { ok: true; request: CreateConnectIntentRequest }
  | Extract<ReturnPathNormalizationResult, { ok: false }>
  | { ok: false; error: 'invalid_product_id' };

export function buildConnectSellerProductIntentRequest(
  input: BuildConnectSellerIntentRequestInput,
): BuildConnectSellerIntentRequestResult {
  const returnPathResult = normalizeReturnPath(input.returnPath);
  if (!returnPathResult.ok) return returnPathResult;

  return {
    ok: true,
    request: {
      action: { type: 'seller-product-manager' },
      returnPath: returnPathResult.returnPath,
      state: input.state,
      ...(input.initiatingOrigin === undefined ? {} : { initiatingOrigin: input.initiatingOrigin }),
    },
  };
}

export function buildConnectSellerListingIntentRequest(
  input: BuildConnectSellerListingIntentRequestInput,
): BuildConnectSellerIntentRequestResult {
  const returnPathResult = normalizeReturnPath(input.returnPath);
  if (!returnPathResult.ok) return returnPathResult;
  if (input.productId.trim().length === 0) {
    return { ok: false, error: 'invalid_product_id' };
  }

  return {
    ok: true,
    request: {
      action: {
        type: 'seller-listing-manager',
        productId: input.productId,
      },
      returnPath: returnPathResult.returnPath,
      state: input.state,
      ...(input.initiatingOrigin === undefined ? {} : { initiatingOrigin: input.initiatingOrigin }),
    },
  };
}
