import type {
  ConnectBidTarget,
  ConnectBidTerms,
  ConnectActionInput,
  ConnectAcceptOfferTarget,
  ConnectBatchOfferCreateTerms,
  ConnectBuyTarget,
  ConnectCancelOfferTerms,
  ConnectErc1155ListingTarget,
  ConnectErc721BatchOfferCreateTarget,
  ConnectErc721BatchOfferTarget,
  ConnectErc721ReserveAuctionTarget,
  ConnectErc721OfferTarget,
  ConnectExpectedOfferTerms,
  ConnectExpectedPriceTerms,
  ConnectExpectedUnitPriceTerms,
  ConnectMintTarget,
  ConnectOfferTerms,
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

export type SettleActionParams = ActionParamsBase & {
  target: ConnectErc721ReserveAuctionTarget;
};

export type MintActionParams = ActionParamsBase & {
  target: ConnectMintTarget;
  purchase: ConnectPurchaseTerms;
};

type Erc721MakeOfferActionParams = ActionParamsBase & {
  target: ConnectErc721OfferTarget;
  offer: ConnectOfferTerms;
};

type Erc721BatchMakeOfferActionParams = ActionParamsBase & {
  target: ConnectErc721BatchOfferCreateTarget;
  offer: ConnectBatchOfferCreateTerms;
};

export type MakeOfferActionParams = Erc721MakeOfferActionParams | Erc721BatchMakeOfferActionParams;

export type AcceptOfferActionParams = ActionParamsBase & {
  target: ConnectAcceptOfferTarget;
  expected: ConnectExpectedOfferTerms;
};

type Erc721CancelOfferActionParams = ActionParamsBase & {
  target: ConnectErc721OfferTarget;
  offer: ConnectCancelOfferTerms;
};

type Erc721BatchCancelOfferActionParams = ActionParamsBase & {
  target: ConnectErc721BatchOfferTarget;
};

export type CancelOfferActionParams = Erc721CancelOfferActionParams | Erc721BatchCancelOfferActionParams;

export type BuildConnectBuyIntentRequestInput = BuyActionParams & {
  state: string;
};

export type BuildConnectBidIntentRequestInput = BidActionParams & {
  state: string;
};

export type BuildConnectSettleIntentRequestInput = SettleActionParams & {
  state: string;
};

export type BuildConnectMintIntentRequestInput = MintActionParams & {
  state: string;
};

export type BuildConnectMakeOfferIntentRequestInput = MakeOfferActionParams & {
  state: string;
};

export type BuildConnectAcceptOfferIntentRequestInput = AcceptOfferActionParams & {
  state: string;
};

export type BuildConnectCancelOfferIntentRequestInput = CancelOfferActionParams & {
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

export function buildConnectSettleIntentRequest(
  input: BuildConnectSettleIntentRequestInput,
): BuildConnectActionIntentRequestResult {
  const sharedResult = buildSharedActionFields(input);
  if (!sharedResult.ok) return sharedResult;

  return {
    ok: true,
    request: {
      action: {
        type: 'settle',
        target: input.target,
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

export function buildConnectMakeOfferIntentRequest(
  input: BuildConnectMakeOfferIntentRequestInput,
): BuildConnectActionIntentRequestResult {
  const sharedResult = buildSharedActionFields(input);
  if (!sharedResult.ok) return sharedResult;

  return {
    ok: true,
    request: {
      action: buildConnectMakeOfferAction(input),
      returnPath: sharedResult.returnPath,
      state: input.state,
      ...(input.initiatingOrigin === undefined ? {} : { initiatingOrigin: input.initiatingOrigin }),
    },
  };
}

function buildConnectMakeOfferAction(
  input: BuildConnectMakeOfferIntentRequestInput,
): Extract<ConnectActionInput, { type: 'offer' }> {
  if (isErc721BatchMakeOfferIntentRequestInput(input)) {
    return {
      type: 'offer',
      target: input.target,
      offer: input.offer,
    };
  }

  return {
    type: 'offer',
    target: input.target,
    offer: input.offer,
  };
}

function isErc721BatchMakeOfferIntentRequestInput(
  input: BuildConnectMakeOfferIntentRequestInput,
): input is Erc721BatchMakeOfferActionParams & { state: string } {
  return input.target.kind === 'erc721-batch-offer';
}

export function buildConnectAcceptOfferIntentRequest(
  input: BuildConnectAcceptOfferIntentRequestInput,
): BuildConnectActionIntentRequestResult {
  const sharedResult = buildSharedActionFields(input);
  if (!sharedResult.ok) return sharedResult;

  return {
    ok: true,
    request: {
      action: {
        type: 'offer-accept',
        target: input.target,
        expected: input.expected,
      },
      returnPath: sharedResult.returnPath,
      state: input.state,
      ...(input.initiatingOrigin === undefined ? {} : { initiatingOrigin: input.initiatingOrigin }),
    },
  };
}

export function buildConnectCancelOfferIntentRequest(
  input: BuildConnectCancelOfferIntentRequestInput,
): BuildConnectActionIntentRequestResult {
  const sharedResult = buildSharedActionFields(input);
  if (!sharedResult.ok) return sharedResult;

  return {
    ok: true,
    request: {
      action: buildConnectCancelOfferAction(input),
      returnPath: sharedResult.returnPath,
      state: input.state,
      ...(input.initiatingOrigin === undefined ? {} : { initiatingOrigin: input.initiatingOrigin }),
    },
  };
}

function buildConnectCancelOfferAction(
  input: BuildConnectCancelOfferIntentRequestInput,
): Extract<ConnectActionInput, { type: 'offer-cancel' }> {
  if (isErc721BatchCancelOfferIntentRequestInput(input)) {
    return {
      type: 'offer-cancel',
      target: input.target,
    };
  }

  return {
    type: 'offer-cancel',
    target: input.target,
    offer: input.offer,
  };
}

function isErc721BatchCancelOfferIntentRequestInput(
  input: BuildConnectCancelOfferIntentRequestInput,
): input is Erc721BatchCancelOfferActionParams & { state: string } {
  return input.target.kind === 'erc721-batch-offer';
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
