import { describe, expect, it } from 'vitest';
import {
  buildConnectAcceptOfferIntentRequest,
  buildConnectBidIntentRequest,
  buildConnectBuyIntentRequest,
  buildConnectCancelOfferIntentRequest,
  buildConnectMakeOfferIntentRequest,
  buildConnectMintIntentRequest,
  buildConnectSellIntentRequest,
  buildConnectSettleIntentRequest,
  buildConnectTransferIntentRequest,
} from '../src/actions-flow-core.js';
import type {
  ConnectErc721BatchOfferAcceptTarget,
  ConnectErc721BatchOfferCreateTarget,
  ConnectErc721BatchOfferTarget,
  ConnectErc721DirectListingTarget,
  ConnectErc721OfferTarget,
  ConnectErc721ReleaseTarget,
  ConnectErc721ReserveAuctionTarget,
  ConnectErc721ScheduledAuctionTarget,
  ConnectLiquidEditionTarget,
} from '../src/auth-flow-core.js';

const directListingTarget: ConnectErc721DirectListingTarget = {
  kind: 'erc721-direct-listing',
  chainId: 1,
  contract: '0x1234567890123456789012345678901234567890',
  tokenId: '123',
};

const reserveAuctionTarget: ConnectErc721ReserveAuctionTarget = {
  kind: 'erc721-reserve-auction',
  chainId: 1,
  contract: '0x1234567890123456789012345678901234567890',
  tokenId: '123',
};

const scheduledAuctionTarget: ConnectErc721ScheduledAuctionTarget = {
  kind: 'erc721-scheduled-auction',
  chainId: 1,
  contract: '0x1234567890123456789012345678901234567890',
  tokenId: '123',
};

const releaseTarget: ConnectErc721ReleaseTarget = {
  kind: 'erc721-release',
  chainId: 1,
  contract: '0x1234567890123456789012345678901234567890',
};

const offerTarget: ConnectErc721OfferTarget = {
  kind: 'erc721-offer',
  chainId: 1,
  contract: '0x1234567890123456789012345678901234567890',
  tokenId: '123',
};

const batchOfferCreateTarget: ConnectErc721BatchOfferCreateTarget = {
  kind: 'erc721-batch-offer',
  chainId: 1,
  tokens: [
    { contract: '0x1234567890123456789012345678901234567890', tokenId: '123' },
    { contract: '0x1234567890123456789012345678901234567890', tokenId: '456' },
  ],
};

const batchOfferAcceptTarget: ConnectErc721BatchOfferAcceptTarget = {
  kind: 'erc721-batch-offer',
  chainId: 1,
  creator: '0x2222222222222222222222222222222222222222',
  root: '0xroot',
  contract: '0x1234567890123456789012345678901234567890',
  tokenId: '123',
};

const batchOfferTarget: ConnectErc721BatchOfferTarget = {
  kind: 'erc721-batch-offer',
  chainId: 1,
  creator: '0x2222222222222222222222222222222222222222',
  root: '0xroot',
};

const liquidEditionTarget: ConnectLiquidEditionTarget = {
  kind: 'liquid-edition',
  chainId: 11155111,
  contract: '0x5547E40bAb6f1e967F0031A53Ea288dC22cbFA5a',
};

const invalidBaseUnitAmounts = ['0', '01', '1.5', '-1', '1e18', ' 1', ''];
const invalidSlippageBps = [0, 501, 49.5, -50, Number.NaN];

describe('buildConnectBuyIntentRequest', () => {
  it('builds a buy intent request with a direct listing target', () => {
    expect(buildConnectBuyIntentRequest({
      target: directListingTarget,
      expected: { currency: 'ETH', price: '1.2' },
      returnPath: '/buy/complete',
      state: 'state_123',
    })).toEqual({
      ok: true,
      request: {
        action: {
          type: 'buy',
          target: directListingTarget,
          expected: { currency: 'ETH', price: '1.2' },
        },
        returnPath: '/buy/complete',
        state: 'state_123',
      },
    });
  });

  it('rejects unsafe return paths before API requests', () => {
    expect(buildConnectBuyIntentRequest({
      target: directListingTarget,
      expected: { currency: 'ETH', price: '1.2' },
      returnPath: 'https://evil.example/buy',
      state: 'state_123',
    })).toEqual({
      ok: false,
      error: 'invalid_return_path',
    });
  });
});

describe('buildConnectBidIntentRequest', () => {
  it('builds a bid intent request with a reserve auction target', () => {
    expect(buildConnectBidIntentRequest({
      target: reserveAuctionTarget,
      bid: { currency: 'ETH', amount: '1.2' },
      returnPath: '/bid/complete',
      state: 'state_123',
    })).toEqual({
      ok: true,
      request: {
        action: {
          type: 'bid',
          target: reserveAuctionTarget,
          bid: { currency: 'ETH', amount: '1.2' },
        },
        returnPath: '/bid/complete',
        state: 'state_123',
      },
    });
  });
});

describe('buildConnectBidIntentRequest with a scheduled auction', () => {
  it('builds a bid intent request with a scheduled auction target', () => {
    expect(buildConnectBidIntentRequest({
      target: scheduledAuctionTarget,
      bid: { currency: 'ETH', amount: '1200000000000000000' },
      returnPath: '/bid/complete',
      state: 'state_123',
    })).toEqual({
      ok: true,
      request: {
        action: {
          type: 'bid',
          target: scheduledAuctionTarget,
          bid: { currency: 'ETH', amount: '1200000000000000000' },
        },
        returnPath: '/bid/complete',
        state: 'state_123',
      },
    });
  });
});

describe('buildConnectMintIntentRequest', () => {
  it('builds a mint intent request with a release target', () => {
    expect(buildConnectMintIntentRequest({
      target: releaseTarget,
      purchase: { quantity: '2', currency: 'ETH', unitPrice: '0.5' },
      returnPath: '/mint/complete',
      state: 'state_123',
    })).toEqual({
      ok: true,
      request: {
        action: {
          type: 'mint',
          target: releaseTarget,
          purchase: { quantity: '2', currency: 'ETH', unitPrice: '0.5' },
        },
        returnPath: '/mint/complete',
        state: 'state_123',
      },
    });
  });

  it('carries a wallet-only payment hint into the intent request', () => {
    const result = buildConnectMintIntentRequest({
      target: releaseTarget,
      purchase: { quantity: '1', currency: 'ETH', unitPrice: '0.042' },
      payment: { method: 'wallet' },
      returnPath: '/mint/complete',
      state: 'state_123',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.payment).toEqual({ method: 'wallet' });
    }
  });

  it('omits the payment field when no hint is given', () => {
    const result = buildConnectMintIntentRequest({
      target: releaseTarget,
      purchase: { quantity: '1', currency: 'ETH', unitPrice: '0.042' },
      returnPath: '/mint/complete',
      state: 'state_123',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect('payment' in result.request).toBe(false);
    }
  });
});

describe('buildConnectMakeOfferIntentRequest', () => {
  it('builds a make-offer intent request with a single offer target', () => {
    expect(buildConnectMakeOfferIntentRequest({
      target: offerTarget,
      offer: { currency: 'ETH', amount: '1.2' },
      returnPath: '/offer/complete',
      state: 'state_123',
    })).toEqual({
      ok: true,
      request: {
        action: {
          type: 'offer',
          target: offerTarget,
          offer: { currency: 'ETH', amount: '1.2' },
        },
        returnPath: '/offer/complete',
        state: 'state_123',
      },
    });
  });

  it('builds a make-offer intent request with a batch create target', () => {
    expect(buildConnectMakeOfferIntentRequest({
      target: batchOfferCreateTarget,
      offer: { currency: 'ETH', amount: '1.2', expiresAt: '1750550400' },
      returnPath: '/offer/complete',
      state: 'state_123',
    })).toEqual({
      ok: true,
      request: {
        action: {
          type: 'offer',
          target: batchOfferCreateTarget,
          offer: { currency: 'ETH', amount: '1.2', expiresAt: '1750550400' },
        },
        returnPath: '/offer/complete',
        state: 'state_123',
      },
    });
  });

  it('rejects unsafe return paths before API requests', () => {
    expect(buildConnectMakeOfferIntentRequest({
      target: offerTarget,
      offer: { currency: 'ETH', amount: '1.2' },
      returnPath: 'https://evil.example/offer',
      state: 'state_123',
    })).toEqual({
      ok: false,
      error: 'invalid_return_path',
    });
  });
});

describe('buildConnectAcceptOfferIntentRequest', () => {
  it('builds an accept-offer intent request with a single offer target', () => {
    expect(buildConnectAcceptOfferIntentRequest({
      target: offerTarget,
      expected: { currency: 'ETH', amount: '1.2' },
      returnPath: '/offer/accept/complete',
      state: 'state_123',
    })).toEqual({
      ok: true,
      request: {
        action: {
          type: 'offer-accept',
          target: offerTarget,
          expected: { currency: 'ETH', amount: '1.2' },
        },
        returnPath: '/offer/accept/complete',
        state: 'state_123',
      },
    });
  });

  it('builds an accept-offer intent request with a batch accept target', () => {
    expect(buildConnectAcceptOfferIntentRequest({
      target: batchOfferAcceptTarget,
      expected: { currency: 'ETH', amount: '1.2' },
      returnPath: '/offer/accept/complete',
      state: 'state_123',
    })).toEqual({
      ok: true,
      request: {
        action: {
          type: 'offer-accept',
          target: batchOfferAcceptTarget,
          expected: { currency: 'ETH', amount: '1.2' },
        },
        returnPath: '/offer/accept/complete',
        state: 'state_123',
      },
    });
  });
});

describe('buildConnectCancelOfferIntentRequest', () => {
  it('builds a cancel-offer intent request with a single offer target', () => {
    expect(buildConnectCancelOfferIntentRequest({
      target: offerTarget,
      offer: { currency: 'ETH' },
      returnPath: '/offer/cancel/complete',
      state: 'state_123',
    })).toEqual({
      ok: true,
      request: {
        action: {
          type: 'offer-cancel',
          target: offerTarget,
          offer: { currency: 'ETH' },
        },
        returnPath: '/offer/cancel/complete',
        state: 'state_123',
      },
    });
  });

  it('builds a cancel-offer intent request that revokes a batch offer', () => {
    expect(buildConnectCancelOfferIntentRequest({
      target: batchOfferTarget,
      returnPath: '/offer/cancel/complete',
      state: 'state_123',
    })).toEqual({
      ok: true,
      request: {
        action: {
          type: 'offer-cancel',
          target: batchOfferTarget,
        },
        returnPath: '/offer/cancel/complete',
        state: 'state_123',
      },
    });
  });
});

describe('buildConnectSettleIntentRequest', () => {
  it('builds a settle intent request with a reserve auction target', () => {
    expect(buildConnectSettleIntentRequest({
      target: reserveAuctionTarget,
      returnPath: '/settle/complete',
      state: 'state_123',
    })).toEqual({
      ok: true,
      request: {
        action: {
          type: 'settle',
          target: reserveAuctionTarget,
        },
        returnPath: '/settle/complete',
        state: 'state_123',
      },
    });
  });
});

describe('buildConnectBuyIntentRequest with a liquid edition', () => {
  it.each([
    { currency: 'ETH', amount: '10000000000000000' },
    { currency: 'RARE', amount: '307019230590695710510' },
    { currency: 'USDC', amount: '68649863' },
  ] as const)('builds a buy that spends $currency', (spend) => {
    expect(buildConnectBuyIntentRequest({
      target: liquidEditionTarget,
      spend,
      returnPath: '/liquid/complete',
      state: 'state_123',
    })).toEqual({
      ok: true,
      request: {
        action: {
          type: 'buy',
          target: liquidEditionTarget,
          spend,
        },
        returnPath: '/liquid/complete',
        state: 'state_123',
      },
    });
  });

  it('carries the minimum received, the slippage cap, and a wallet payment hint', () => {
    expect(buildConnectBuyIntentRequest({
      target: liquidEditionTarget,
      spend: { currency: 'ETH', amount: '10000000000000000' },
      minReceived: '175380585344332596185',
      maxSlippageBps: 100,
      payment: { method: 'wallet' },
      initiatingOrigin: 'https://artist.example',
      state: 'state_123',
    })).toEqual({
      ok: true,
      request: {
        action: {
          type: 'buy',
          target: liquidEditionTarget,
          spend: { currency: 'ETH', amount: '10000000000000000' },
          minReceived: '175380585344332596185',
          maxSlippageBps: 100,
        },
        returnPath: '/',
        state: 'state_123',
        initiatingOrigin: 'https://artist.example',
        payment: { method: 'wallet' },
      },
    });
  });

  it.each([1, 500])('accepts a slippage cap of %i basis points', (maxSlippageBps) => {
    expect(buildConnectBuyIntentRequest({
      target: liquidEditionTarget,
      spend: { currency: 'ETH', amount: '10000000000000000' },
      maxSlippageBps,
      state: 'state_123',
    })).toMatchObject({ ok: true, request: { action: { maxSlippageBps } } });
  });

  it.each(invalidBaseUnitAmounts)('rejects the spend amount %j', (amount) => {
    expect(buildConnectBuyIntentRequest({
      target: liquidEditionTarget,
      spend: { currency: 'ETH', amount },
      state: 'state_123',
    })).toEqual({ ok: false, error: 'invalid_amount' });
  });

  it.each(invalidBaseUnitAmounts)('rejects the minimum received %j', (minReceived) => {
    expect(buildConnectBuyIntentRequest({
      target: liquidEditionTarget,
      spend: { currency: 'ETH', amount: '10000000000000000' },
      minReceived,
      state: 'state_123',
    })).toEqual({ ok: false, error: 'invalid_min_received' });
  });

  it.each(invalidSlippageBps)('rejects a slippage cap of %d basis points', (maxSlippageBps) => {
    expect(buildConnectBuyIntentRequest({
      target: liquidEditionTarget,
      spend: { currency: 'ETH', amount: '10000000000000000' },
      maxSlippageBps,
      state: 'state_123',
    })).toEqual({ ok: false, error: 'invalid_max_slippage_bps' });
  });

  it('rejects unsafe return paths before validating the trade', () => {
    expect(buildConnectBuyIntentRequest({
      target: liquidEditionTarget,
      spend: { currency: 'ETH', amount: '0' },
      returnPath: 'https://evil.example/liquid',
      state: 'state_123',
    })).toEqual({ ok: false, error: 'invalid_return_path' });
  });

  it('does not type card payment for a liquid edition', () => {
    // @ts-expect-error Liquid Edition trades are wallet-only.
    const result = buildConnectBuyIntentRequest({
      target: liquidEditionTarget,
      spend: { currency: 'ETH', amount: '10000000000000000' },
      payment: { method: 'card' },
      state: 'state_123',
    });

    expect(result).toMatchObject({ ok: true });
  });
});

describe('buildConnectSellIntentRequest', () => {
  it.each(['ETH', 'RARE', 'USDC'] as const)('builds a sell that receives %s', (currency) => {
    expect(buildConnectSellIntentRequest({
      target: liquidEditionTarget,
      sell: { amount: '44065473704606179946' },
      receive: { currency },
      returnPath: '/liquid/complete',
      state: 'state_123',
    })).toEqual({
      ok: true,
      request: {
        action: {
          type: 'sell',
          target: liquidEditionTarget,
          sell: { amount: '44065473704606179946' },
          receive: { currency },
        },
        returnPath: '/liquid/complete',
        state: 'state_123',
      },
    });
  });

  it('carries the minimum received, the slippage cap, and a wallet payment hint', () => {
    expect(buildConnectSellIntentRequest({
      target: liquidEditionTarget,
      sell: { amount: '44065473704606179946' },
      receive: { currency: 'USDC' },
      minReceived: '68306625',
      maxSlippageBps: 50,
      payment: { method: 'wallet' },
      state: 'state_123',
    })).toEqual({
      ok: true,
      request: {
        action: {
          type: 'sell',
          target: liquidEditionTarget,
          sell: { amount: '44065473704606179946' },
          receive: { currency: 'USDC' },
          minReceived: '68306625',
          maxSlippageBps: 50,
        },
        returnPath: '/',
        state: 'state_123',
        payment: { method: 'wallet' },
      },
    });
  });

  it.each(invalidBaseUnitAmounts)('rejects the sell amount %j', (amount) => {
    expect(buildConnectSellIntentRequest({
      target: liquidEditionTarget,
      sell: { amount },
      receive: { currency: 'ETH' },
      state: 'state_123',
    })).toEqual({ ok: false, error: 'invalid_amount' });
  });

  it.each(invalidBaseUnitAmounts)('rejects the minimum received %j', (minReceived) => {
    expect(buildConnectSellIntentRequest({
      target: liquidEditionTarget,
      sell: { amount: '44065473704606179946' },
      receive: { currency: 'ETH' },
      minReceived,
      state: 'state_123',
    })).toEqual({ ok: false, error: 'invalid_min_received' });
  });

  it.each(invalidSlippageBps)('rejects a slippage cap of %d basis points', (maxSlippageBps) => {
    expect(buildConnectSellIntentRequest({
      target: liquidEditionTarget,
      sell: { amount: '44065473704606179946' },
      receive: { currency: 'ETH' },
      maxSlippageBps,
      state: 'state_123',
    })).toEqual({ ok: false, error: 'invalid_max_slippage_bps' });
  });

  it('rejects unsafe return paths before API requests', () => {
    expect(buildConnectSellIntentRequest({
      target: liquidEditionTarget,
      sell: { amount: '44065473704606179946' },
      receive: { currency: 'ETH' },
      returnPath: '//evil.example/liquid',
      state: 'state_123',
    })).toEqual({ ok: false, error: 'invalid_return_path' });
  });

  it('does not type card payment for a liquid edition', () => {
    const result = buildConnectSellIntentRequest({
      target: liquidEditionTarget,
      sell: { amount: '44065473704606179946' },
      receive: { currency: 'ETH' },
      // @ts-expect-error Liquid Edition trades are wallet-only.
      payment: { method: 'card' },
      state: 'state_123',
    });

    expect(result).toMatchObject({ ok: true });
  });
});

describe('buildConnectTransferIntentRequest', () => {
  const recipient = '0x52908400098527886E0F7030069857D2E4169EE7';

  it.each([
    { chainId: 1, currency: 'ETH', amount: '50000000000000000' },
    { chainId: 11155111, currency: 'USDC', amount: '25000000' },
  ] as const)('builds a $currency transfer on chain $chainId', ({ chainId, currency, amount }) => {
    expect(buildConnectTransferIntentRequest({
      chainId,
      to: recipient,
      currency,
      amount,
      returnPath: '/credits/complete',
      initiatingOrigin: 'https://game.example',
      state: 'state_123',
    })).toEqual({
      ok: true,
      request: {
        action: {
          type: 'transfer',
          target: { kind: 'wallet', chainId, address: recipient },
          transfer: { currency, amount },
        },
        returnPath: '/credits/complete',
        state: 'state_123',
        initiatingOrigin: 'https://game.example',
      },
    });
  });

  it.each(['0', '00', '01', '0.05', '1.5', '-1', '1e18', ' 1', '1 ', ''])('rejects the amount %j', (amount) => {
    expect(buildConnectTransferIntentRequest({
      chainId: 1,
      to: recipient,
      currency: 'ETH',
      amount,
      state: 'state_123',
    })).toEqual({ ok: false, error: 'invalid_amount' });
  });

  it.each([
    'https://evil.example/credits',
    '//evil.example/credits',
    '/credits%2f..%2fevil',
  ])('rejects the unsafe return path %j before validating the amount', (returnPath) => {
    expect(buildConnectTransferIntentRequest({
      chainId: 1,
      to: recipient,
      currency: 'ETH',
      amount: '0',
      returnPath,
      state: 'state_123',
    })).toEqual({ ok: false, error: 'invalid_return_path' });
  });

  it('does not type a payment and never forwards one', () => {
    expect(buildConnectTransferIntentRequest({
      chainId: 1,
      to: recipient,
      currency: 'ETH',
      amount: '50000000000000000',
      // @ts-expect-error Transfers are wallet-only.
      payment: { method: 'card' },
      state: 'state_123',
    })).toEqual({
      ok: true,
      request: {
        action: {
          type: 'transfer',
          target: { kind: 'wallet', chainId: 1, address: recipient },
          transfer: { currency: 'ETH', amount: '50000000000000000' },
        },
        returnPath: '/',
        state: 'state_123',
      },
    });
  });
});
