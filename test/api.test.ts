import { describe, expect, it, vi } from 'vitest';
import {
  createConnectIntent,
  createConnectLoginIntent,
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
  it('creates login intents', async () => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);

      expect(request.method).toBe('POST');
      expect(request.url).toBe('https://rare-api.test/v1/connect/intents');
      expect(await request.json()).toEqual({
        action: { type: 'login' },
        returnPath: '/account',
        state: 'state_123',
        initiatingOrigin: 'https://artist.example',
      });

      return jsonResponse({
        data: {
          intentId: 'connect_intent_123',
          url: 'https://connect.superrare.test/login?intentId=connect_intent_123',
          expiresAt: '2026-06-22T00:00:00.000Z',
        },
      });
    });

    await expect(createConnectLoginIntent({
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
      request: {
        action: { type: 'login' },
        returnPath: '/account',
        state: 'state_123',
        initiatingOrigin: 'https://artist.example',
      },
    })).resolves.toEqual({
      intentId: 'connect_intent_123',
      url: 'https://connect.superrare.test/login?intentId=connect_intent_123',
      expiresAt: '2026-06-22T00:00:00.000Z',
    });
  });

  it('creates checkout intents through the generic intent client', async () => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);

      expect(request.method).toBe('POST');
      expect(request.url).toBe('https://rare-api.test/v1/connect/intents');
      expect(await request.json()).toEqual({
        action: {
          type: 'checkout',
          target: checkoutTarget,
        },
        returnPath: '/thanks',
        state: 'state_123',
      });

      return jsonResponse({
        data: {
          intentId: 'connect_intent_checkout',
          url: 'https://connect.superrare.test/checkout/connect_checkout_session_123?intentId=connect_intent_checkout',
          expiresAt: '2026-06-22T00:00:00.000Z',
        },
      });
    });

    await expect(createConnectIntent({
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
      request: {
        action: {
          type: 'checkout',
          target: checkoutTarget,
        },
        returnPath: '/thanks',
        state: 'state_123',
      },
    })).resolves.toMatchObject({
      intentId: 'connect_intent_checkout',
    });
  });

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
