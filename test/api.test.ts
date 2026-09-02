import { describe, expect, it, vi } from 'vitest';
import {
  getConnectCheckoutStatus,
  getConnectCurrentUser,
  getConnectIntent,
  getConnectSession,
} from '../src/api.js';
import type { ConnectErc1155CheckoutTarget } from '../src/auth-flow-core.js';

const checkoutTarget: ConnectErc1155CheckoutTarget = {
  kind: 'erc1155-checkout',
  chainId: 1,
  items: [
    {
      kind: 'listing',
      contract: '0x1234567890123456789012345678901234567890',
      seller: '0x2222222222222222222222222222222222222222',
      tokenId: '123',
      quantity: '2',
      expected: { currency: 'ETH', unitPrice: '1.2' },
    },
  ],
};

describe('Connect API client', () => {
  it('gets intent status', async () => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);

      expect(request.method).toBe('GET');
      expect(request.url).toBe('https://rare-api.test/v1/connect/intents/connect_intent_123');

      return jsonResponse({
        data: {
          intentId: 'connect_intent_123',
          type: 'checkout',
          status: 'completed',
          returnPath: '/thanks',
          expiresAt: '2026-06-22T00:00:00.000Z',
          result: { transactionHash: '0xtransaction' },
        },
      });
    });

    await expect(getConnectIntent({
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
      intentId: 'connect_intent_123',
    })).resolves.toMatchObject({
      intentId: 'connect_intent_123',
      status: 'completed',
    });
  });

  it('parses intent status carrying an offer snapshot with buyer and expiry terms', async () => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);

      expect(request.method).toBe('GET');
      expect(request.url).toBe('https://rare-api.test/v1/connect/intents/connect_intent_offer');

      return jsonResponse({
        data: {
          intentId: 'connect_intent_offer',
          type: 'offer',
          status: 'completed',
          returnPath: '/offer/complete',
          expiresAt: '2026-06-22T00:00:00.000Z',
          resolvedActionSnapshot: {
            actionKey: 'offer_key',
            actionType: 'offer',
            resolvedAt: '2026-06-21T00:00:00.000Z',
            targetKind: 'erc721-offer',
            terms: {
              available: true,
              amount: '1.2',
              currency: 'ETH',
              buyer: '0x0000000000000000000000000000000000000001',
              expiry: '1750550400',
            },
          },
          result: { transactionHash: '0xtransaction' },
        },
      });
    });

    await expect(getConnectIntent({
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
      intentId: 'connect_intent_offer',
    })).resolves.toMatchObject({
      intentId: 'connect_intent_offer',
      type: 'offer',
      resolvedActionSnapshot: {
        targetKind: 'erc721-offer',
        terms: {
          buyer: '0x0000000000000000000000000000000000000001',
          expiry: '1750550400',
        },
      },
    });
  });

  it('gets checkout status', async () => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);

      expect(request.method).toBe('GET');
      expect(request.url).toBe('https://rare-api.test/v1/connect/checkout/connect_checkout_session_123');

      return jsonResponse({
        data: {
          sessionId: 'connect_checkout_session_123',
          status: 'completed',
          intentId: 'connect_intent_checkout',
          transactionHash: '0xtransaction',
        },
      });
    });

    await expect(getConnectCheckoutStatus({
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
      sessionId: 'connect_checkout_session_123',
    })).resolves.toMatchObject({
      sessionId: 'connect_checkout_session_123',
      status: 'completed',
    });
  });

  it('parses checkout status carrying a batch-offer snapshot with buyer and expiry terms', async () => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);

      expect(request.method).toBe('GET');
      expect(request.url).toBe('https://rare-api.test/v1/connect/checkout/connect_checkout_session_offer');

      return jsonResponse({
        data: {
          sessionId: 'connect_checkout_session_offer',
          status: 'completed',
          intentId: 'connect_intent_offer_accept',
          transactionHash: '0xtransaction',
          resolvedActionSnapshot: {
            actionKey: 'offer_accept_key',
            actionType: 'offer-accept',
            resolvedAt: '2026-06-21T00:00:00.000Z',
            targetKind: 'erc721-batch-offer',
            terms: {
              available: true,
              amount: '1.2',
              currency: 'ETH',
              buyer: '0x0000000000000000000000000000000000000001',
              expiry: '1750550400',
              merkleRoot: '0xroot',
            },
          },
        },
      });
    });

    await expect(getConnectCheckoutStatus({
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
      sessionId: 'connect_checkout_session_offer',
    })).resolves.toMatchObject({
      sessionId: 'connect_checkout_session_offer',
      status: 'completed',
      resolvedActionSnapshot: {
        targetKind: 'erc721-batch-offer',
        terms: {
          buyer: '0x0000000000000000000000000000000000000001',
          expiry: '1750550400',
        },
      },
    });
  });

  it('gets API-backed session state with bearer auth', async () => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);

      expect(request.method).toBe('GET');
      expect(request.url).toBe('https://rare-api.test/v1/connect/session');
      expect(request.headers.get('authorization')).toBe('Bearer connect_session_123');

      return jsonResponse({
        data: {
          authenticated: true,
          session: {
            sessionId: 'connect_session_123',
            userId: 'user_123',
            address: '0x0000000000000000000000000000000000000001',
            expiresAt: '2026-06-22T00:00:00.000Z',
          },
        },
      });
    });

    await expect(getConnectSession({
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
      sessionId: 'connect_session_123',
    })).resolves.toEqual({
      authenticated: true,
      session: {
        sessionId: 'connect_session_123',
        userId: 'user_123',
        address: '0x0000000000000000000000000000000000000001',
        expiresAt: '2026-06-22T00:00:00.000Z',
      },
    });
  });

  it('gets current user with bearer auth', async () => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);

      expect(request.method).toBe('GET');
      expect(request.url).toBe('https://rare-api.test/v1/connect/users/me');
      expect(request.headers.get('authorization')).toBe('Bearer connect_session_123');

      return jsonResponse({
        data: {
          address: '0x0000000000000000000000000000000000000001',
          username: 'artist',
          fullName: 'Artist Name',
          avatarUri: null,
        },
      });
    });

    await expect(getConnectCurrentUser({
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
      sessionId: 'connect_session_123',
    })).resolves.toEqual({
      address: '0x0000000000000000000000000000000000000001',
      username: 'artist',
      fullName: 'Artist Name',
      avatarUri: null,
    });
  });
});

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json' },
  });
}
