import { describe, expect, it } from 'vitest';
import {
  buildConnectAcceptOfferIntentRequest,
  buildConnectBidIntentRequest,
  buildConnectBuyIntentRequest,
  buildConnectCancelOfferIntentRequest,
  buildConnectMakeOfferIntentRequest,
  buildConnectMintIntentRequest,
} from '../src/actions-flow-core.js';
import type {
  ConnectErc721BatchOfferAcceptTarget,
  ConnectErc721BatchOfferCreateTarget,
  ConnectErc721BatchOfferTarget,
  ConnectErc721DirectListingTarget,
  ConnectErc721OfferTarget,
  ConnectErc721ReleaseTarget,
  ConnectErc721ReserveAuctionTarget,
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
