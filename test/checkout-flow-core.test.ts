import { describe, expect, it } from 'vitest';
import { buildConnectCheckoutIntentRequest } from '../src/checkout-flow-core.js';
import type { ConnectErc1155CheckoutTarget } from '../src/auth-flow-core.js';

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
});
