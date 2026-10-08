export type ConnectActionType =
  | 'login'
  | 'checkout'
  | 'bid'
  | 'buy'
  | 'mint'
  | 'offer'
  | 'offer-accept'
  | 'offer-cancel'
  | 'settle'
  | 'sell'
  | 'transfer';

type ConnectOpenStringUnion<Known extends string> = Known | (string & {});

export type ConnectIntentStatus =
  | 'pending'
  | 'requires_user'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired';

export type ConnectIntentResult = {
  approvalTxHash?: string;
  referenceId?: string;
  sessionId?: string;
  transactionHash?: string;
};

export type ConnectActionTargetKind =
  | 'erc721-direct-listing'
  | 'erc721-batch-listing'
  | 'erc1155-listing'
  | 'erc721-reserve-auction'
  | 'erc721-batch-reserve-auction'
  | 'erc721-scheduled-auction'
  | 'erc721-release'
  | 'erc1155-release'
  | 'erc1155-checkout'
  | 'erc721-offer'
  | 'erc721-batch-offer'
  | 'liquid-edition'
  | 'wallet';

export type ConnectResolvedActionSnapshot = {
  actionKey: string;
  actionType: ConnectOpenStringUnion<Exclude<ConnectActionType, 'login'>>;
  resolvedAt: string;
  targetKind: ConnectOpenStringUnion<ConnectActionTargetKind>;
  terms: {
    amount?: string;
    available: boolean;
    buyer?: string;
    currency?: string;
    estimatedAmountOut?: string;
    expiry?: string;
    marketplace?: string;
    merkleRoot?: string;
    merkleProof?: string[];
    minAmountOut?: string;
    outputCurrency?: string;
    price?: string;
    quantity?: string;
    quantityAvailable?: string;
    seller?: string;
    recipient?: string;
    unitPrice?: string;
  };
};

export type ConnectIntent = {
  intentId: string;
  type: ConnectOpenStringUnion<ConnectActionType>;
  status: ConnectIntentStatus;
  initiatingOrigin?: string;
  returnPath: string;
  expiresAt: string;
  resolvedActionSnapshot?: ConnectResolvedActionSnapshot;
  result?: ConnectIntentResult;
  error?: {
    code: string;
    message: string;
  };
};

export type ConnectCheckoutStatusValue =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired';

export type ConnectCheckoutStatus = {
  sessionId: string;
  status: ConnectCheckoutStatusValue;
  initiatingOrigin?: string;
  returnPath?: string;
  intentId?: string;
  expiresAt?: string;
  resolvedActionSnapshot?: ConnectResolvedActionSnapshot;
  approvalTxHash?: string;
  transactionHash?: string;
  error?: {
    code: string;
    message: string;
  };
};

export type ConnectIntentOutcome =
  | { kind: 'pending' }
  | { kind: 'completed'; result?: ConnectIntentResult }
  | { kind: 'failed'; status: 'failed' | 'cancelled' | 'expired'; error?: ConnectIntent['error'] };

export function resolveConnectIntentOutcome(
  intent: Pick<ConnectIntent, 'status' | 'result' | 'error'>,
): ConnectIntentOutcome {
  switch (intent.status) {
    case 'pending':
    case 'requires_user':
    case 'processing':
      return { kind: 'pending' };
    case 'completed':
      return { kind: 'completed', ...(intent.result === undefined ? {} : { result: intent.result }) };
    case 'failed':
    case 'cancelled':
    case 'expired':
      return {
        kind: 'failed',
        status: intent.status,
        ...(intent.error === undefined ? {} : { error: intent.error }),
      };
  }
}
