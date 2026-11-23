import type { ConnectActionValidationErrorCode } from './actions-flow-core.js';
import type {
  ConnectCartCheckoutItem,
  ConnectCartCheckoutTarget,
  ConnectCheckoutTarget,
  ConnectIntentPayment,
  CreateConnectIntentRequest,
} from './auth-flow-core.js';
import { normalizeReturnPath, type ReturnPathNormalizationResult } from './return-path-core.js';

export type CheckoutStartParams = {
  target: ConnectCheckoutTarget;
  returnPath?: string;
  initiatingOrigin?: string;
  /**
   * Set `{ method: 'wallet' }` for sales that must never offer card payment —
   * required for custom settlement contracts that key on the receiving
   * wallet. See {@link ConnectIntentPayment}.
   */
  payment?: ConnectIntentPayment;
};

export type BuildConnectCheckoutIntentRequestInput = CheckoutStartParams & {
  state: string;
};

export type BuildConnectCheckoutIntentRequestResult =
  | { ok: true; request: CreateConnectIntentRequest }
  | Extract<ReturnPathNormalizationResult, { ok: false }>
  | { ok: false; error: ConnectActionValidationErrorCode; message?: string };

type CheckoutTargetBuildResult =
  | { ok: true; target: ConnectCheckoutTarget }
  | { ok: false; error: ConnectActionValidationErrorCode; message?: string };

const maximumCartCheckoutItems = 5;

const listingDigestPattern = /^0x[0-9a-fA-F]{64}$/;
const quantityPattern = /^[1-9]\d*$/;

export function buildConnectCheckoutIntentRequest(
  input: BuildConnectCheckoutIntentRequestInput,
): BuildConnectCheckoutIntentRequestResult {
  const returnPathResult = normalizeReturnPath(input.returnPath);
  if (!returnPathResult.ok) {
    return returnPathResult;
  }

  const targetResult = buildCheckoutTarget(input.target);
  if (!targetResult.ok) return targetResult;

  return {
    ok: true,
    request: {
      action: {
        type: 'checkout',
        target: targetResult.target,
      },
      returnPath: returnPathResult.returnPath,
      state: input.state,
      ...(input.initiatingOrigin === undefined ? {} : { initiatingOrigin: input.initiatingOrigin }),
      ...(input.payment === undefined ? {} : { payment: input.payment }),
    },
  };
}

function buildCheckoutTarget(target: ConnectCheckoutTarget): CheckoutTargetBuildResult {
  switch (target.kind) {
    case 'erc1155-checkout':
      return { ok: true, target };
    case 'cart':
      return buildCartCheckoutTarget(target);
  }
}

function buildCartCheckoutTarget(target: ConnectCartCheckoutTarget): CheckoutTargetBuildResult {
  if (!Number.isSafeInteger(target.chainId) || target.chainId <= 0) {
    return { ok: false, error: 'invalid_chain_id' };
  }

  if (!Array.isArray(target.items) || target.items.length === 0) {
    return {
      ok: false,
      error: 'invalid_cart_items',
      message: 'A Cart checkout needs at least one item.',
    };
  }

  if (target.items.length > maximumCartCheckoutItems) {
    return {
      ok: false,
      error: 'invalid_cart_items',
      message: `A Cart checkout accepts at most ${maximumCartCheckoutItems} items.`,
    };
  }

  if (!target.items.every(hasValidListingDigest)) {
    return { ok: false, error: 'invalid_listing_digest' };
  }

  const distinctListingDigests = new Set(target.items.map((item) => item.listingDigest.toLowerCase()));
  if (distinctListingDigests.size !== target.items.length) {
    return {
      ok: false,
      error: 'invalid_cart_items',
      message: 'A Cart checkout cannot repeat a listing digest.',
    };
  }

  if (!target.items.every(hasValidQuantity)) {
    return { ok: false, error: 'invalid_quantity' };
  }

  return {
    ok: true,
    target: {
      kind: 'cart',
      chainId: target.chainId,
      items: target.items.map((item) => ({
        listingDigest: item.listingDigest,
        quantity: item.quantity,
      })),
    },
  };
}

function hasValidListingDigest(item: ConnectCartCheckoutItem): boolean {
  return isRecord(item) && typeof item.listingDigest === 'string' && listingDigestPattern.test(item.listingDigest);
}

function hasValidQuantity(item: ConnectCartCheckoutItem): boolean {
  return typeof item.quantity === 'string' && quantityPattern.test(item.quantity);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
