import { describe, expect, it } from 'vitest';
import {
  buildConnectBidIntentRequest,
  buildConnectBuyIntentRequest,
  buildConnectMintIntentRequest,
} from '../src/actions-flow-core.js';
import type {
  ConnectErc721DirectListingTarget,
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
