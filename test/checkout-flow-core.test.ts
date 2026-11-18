import { describe, expect, it } from 'vitest';
import { buildConnectCheckoutIntentRequest } from '../src/checkout-flow-core.js';
import type { ConnectCartCheckoutTarget, ConnectErc1155CheckoutTarget } from '../src/auth-flow-core.js';

const checkoutTarget: ConnectErc1155CheckoutTarget = {
  kind: 'erc1155-checkout',
  chainId: 1,
  items: [
    {
      kind: 'release',
      contract: '0x1234567890123456789012345678901234567890',
      tokenId: '123',
      quantity: '2',
      expected: { currency: 'ETH', unitPrice: '1.2' },
    },
  ],
};

const listingDigest = `0x${'cf'.repeat(32)}`;

const cartTarget: ConnectCartCheckoutTarget = {
  kind: 'cart',
  chainId: 8453,
  items: [
    { listingDigest, quantity: '1' },
    { listingDigest: `0x${'AB'.repeat(32)}`, quantity: '3' },
  ],
};

describe('buildConnectCheckoutIntentRequest', () => {
  it('builds a checkout intent request', () => {
    expect(buildConnectCheckoutIntentRequest({
      target: checkoutTarget,
      returnPath: '/thanks',
      state: 'state_123',
      initiatingOrigin: 'https://artist.example',
    })).toEqual({
      ok: true,
      request: {
        action: {
          type: 'checkout',
          target: checkoutTarget,
        },
        returnPath: '/thanks',
        state: 'state_123',
        initiatingOrigin: 'https://artist.example',
      },
    });
  });

  it('rejects unsafe return paths before API requests', () => {
    expect(buildConnectCheckoutIntentRequest({
      target: checkoutTarget,
      returnPath: 'https://evil.example/thanks',
      state: 'state_123',
    })).toEqual({
      ok: false,
      error: 'invalid_return_path',
    });
  });

  it('builds a cart checkout intent request with only the cart fields', () => {
    expect(buildConnectCheckoutIntentRequest({
      target: {
        ...cartTarget,
        items: cartTarget.items.map((item) => ({ ...item, unexpected: 'dropped' })),
      },
      returnPath: '/cart/complete',
      state: 'state_cart',
      initiatingOrigin: 'https://shop.example',
    })).toEqual({
      ok: true,
      request: {
        action: {
          type: 'checkout',
          target: {
            kind: 'cart',
            chainId: 8453,
            items: [
              { listingDigest, quantity: '1' },
              { listingDigest: `0x${'AB'.repeat(32)}`, quantity: '3' },
            ],
          },
        },
        returnPath: '/cart/complete',
        state: 'state_cart',
        initiatingOrigin: 'https://shop.example',
      },
    });
  });

  it.each([
    ['a fractional chainId', { ...cartTarget, chainId: 1.5 }, 'invalid_chain_id'],
    ['a zero chainId', { ...cartTarget, chainId: 0 }, 'invalid_chain_id'],
    ['an empty items list', { ...cartTarget, items: [] }, 'invalid_cart_items'],
    ['a short listing digest', { ...cartTarget, items: [{ listingDigest: '0x1234', quantity: '1' }] }, 'invalid_listing_digest'],
    ['a listing digest without 0x', { ...cartTarget, items: [{ listingDigest: 'cf'.repeat(32), quantity: '1' }] }, 'invalid_listing_digest'],
    ['a non-hex listing digest', { ...cartTarget, items: [{ listingDigest: `0x${'zz'.repeat(32)}`, quantity: '1' }] }, 'invalid_listing_digest'],
    ['a zero quantity', { ...cartTarget, items: [{ listingDigest, quantity: '0' }] }, 'invalid_quantity'],
    ['a leading-zero quantity', { ...cartTarget, items: [{ listingDigest, quantity: '01' }] }, 'invalid_quantity'],
    ['a decimal quantity', { ...cartTarget, items: [{ listingDigest, quantity: '1.5' }] }, 'invalid_quantity'],
    ['a negative quantity', { ...cartTarget, items: [{ listingDigest, quantity: '-1' }] }, 'invalid_quantity'],
  ] satisfies Array<[string, ConnectCartCheckoutTarget, string]>)('rejects a cart with %s', (_label, target, error) => {
    expect(buildConnectCheckoutIntentRequest({
      target,
      state: 'state_cart',
    })).toEqual({ ok: false, error });
  });
});
