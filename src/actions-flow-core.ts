import type {
  ConnectBidTarget,
  ConnectBidTerms,
  ConnectActionInput,
  ConnectBuyTarget,
  ConnectErc1155ListingTarget,
  ConnectExpectedPriceTerms,
  ConnectExpectedUnitPriceTerms,
  ConnectMintTarget,
  ConnectPurchaseTerms,
  CreateConnectIntentRequest,
} from './auth-flow-core.js';
import { normalizeReturnPath, type ReturnPathNormalizationResult } from './return-path-core.js';

type ActionParamsBase = {
  returnPath?: string;
  initiatingOrigin?: string;
};

type Erc721BuyActionParams = ActionParamsBase & {
  target: Exclude<ConnectBuyTarget, ConnectErc1155ListingTarget>;
  expected: ConnectExpectedPriceTerms;
};

type Erc1155BuyActionParams = ActionParamsBase & {
  target: ConnectErc1155ListingTarget;
  expected: ConnectExpectedUnitPriceTerms;
};

export type BuyActionParams = Erc721BuyActionParams | Erc1155BuyActionParams;

export type BidActionParams = ActionParamsBase & {
  target: ConnectBidTarget;
  bid: ConnectBidTerms;
};

export type MintActionParams = ActionParamsBase & {
  target: ConnectMintTarget;
  purchase: ConnectPurchaseTerms;
};

export type BuildConnectBuyIntentRequestInput = BuyActionParams & {
  state: string;
};

export type BuildConnectBidIntentRequestInput = BidActionParams & {
  state: string;
};

export type BuildConnectMintIntentRequestInput = MintActionParams & {
  state: string;
};

export type BuildConnectActionIntentRequestResult =
  | { ok: true; request: CreateConnectIntentRequest }
  | Extract<ReturnPathNormalizationResult, { ok: false }>;

export function buildConnectBuyIntentRequest(
  input: BuildConnectBuyIntentRequestInput,
): BuildConnectActionIntentRequestResult {
  const sharedResult = buildSharedActionFields(input);
  if (!sharedResult.ok) return sharedResult;

  return {
    ok: true,
    request: {
      action: buildConnectBuyAction(input),
      returnPath: sharedResult.returnPath,
      state: input.state,
      ...(input.initiatingOrigin === undefined ? {} : { initiatingOrigin: input.initiatingOrigin }),
    },
  };
}

function buildConnectBuyAction(
  input: BuildConnectBuyIntentRequestInput,
): Extract<ConnectActionInput, { type: 'buy' }> {
  if (isErc1155BuyIntentRequestInput(input)) {
    return {
      type: 'buy',
      target: input.target,
      expected: input.expected,
    };
  }

  return {
    type: 'buy',
    target: input.target,
    expected: input.expected,
  };
}

function isErc1155BuyIntentRequestInput(
  input: BuildConnectBuyIntentRequestInput,
): input is Erc1155BuyActionParams & { state: string } {
  return input.target.kind === 'erc1155-listing';
}

export function buildConnectBidIntentRequest(
  input: BuildConnectBidIntentRequestInput,
): BuildConnectActionIntentRequestResult {
  const sharedResult = buildSharedActionFields(input);
  if (!sharedResult.ok) return sharedResult;

  return {
    ok: true,
    request: {
      action: {
        type: 'bid',
        target: input.target,
        bid: input.bid,
      },
      returnPath: sharedResult.returnPath,
      state: input.state,
      ...(input.initiatingOrigin === undefined ? {} : { initiatingOrigin: input.initiatingOrigin }),
    },
  };
}

export function buildConnectMintIntentRequest(
  input: BuildConnectMintIntentRequestInput,
): BuildConnectActionIntentRequestResult {
  const sharedResult = buildSharedActionFields(input);
  if (!sharedResult.ok) return sharedResult;

  return {
    ok: true,
    request: {
      action: {
        type: 'mint',
        target: input.target,
        purchase: input.purchase,
      },
      returnPath: sharedResult.returnPath,
      state: input.state,
      ...(input.initiatingOrigin === undefined ? {} : { initiatingOrigin: input.initiatingOrigin }),
    },
  };
}

function buildSharedActionFields(input: {
  returnPath?: string;
}): (
  | { ok: true; returnPath: string }
  | Extract<ReturnPathNormalizationResult, { ok: false }>
) {
  const returnPathResult = normalizeReturnPath(input.returnPath);
  if (!returnPathResult.ok) {
    return returnPathResult;
  }

  return {
    ok: true,
    returnPath: returnPathResult.returnPath,
  };
}
