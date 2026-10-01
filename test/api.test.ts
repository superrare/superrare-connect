import { describe, expect, it, vi } from 'vitest';
import {
  createConnectIntent,
  createConnectLoginIntent,
  exchangeConnectAuthCode,
  getConnectCheckoutStatus,
  getConnectCurrentUser,
  getConnectIntent,
  getConnectSession,
  refreshConnectAuthSession,
  revokeConnectAuthSession,
  type ConnectAuthCredentials,
} from '../src/api.js';
import type { ConnectErc1155CheckoutTarget } from '../src/auth-flow-core.js';
import { SuperRareConnectApiError } from '../src/errors.js';

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

const credentials: ConnectAuthCredentials = {
  session: {
    sessionId: 'connect_session_123',
    userId: 'user_123',
    address: '0x0000000000000000000000000000000000000001',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  },
  refreshToken: 'connect_refresh_123',
  refreshExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
};

const malformedCredentials: unknown[] = [
  { session: credentials.session },
  { ...credentials, refreshToken: '' },
  { ...credentials, refreshToken: 'x'.repeat(513) },
  { ...credentials, refreshExpiresAt: 'not a date' },
  { ...credentials, refreshExpiresAt: '2026-02-30T00:00:00.000Z' },
  { ...credentials, session: { ...credentials.session, expiresAt: 'not a date' } },
  { ...credentials, session: { ...credentials.session, expiresAt: '2026-02-30T00:00:00.000Z' } },
  { ...credentials, session: { ...credentials.session, sessionId: '' } },
];

describe('Connect API client', () => {
  it('exchanges the callback for access and refresh credentials', async () => {
    const params = { code: 'connect_auth_code_123', intentId: 'connect_intent_123', state: 'state_123' };
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);
      expect(request.url).toBe('https://rare-api.test/v1/connect/auth/exchange');
      expect(request.method).toBe('POST');
      expect(request.headers.get('content-type')).toBe('application/json');
      expect(request.headers.has('authorization')).toBe(false);
      expect(await request.json()).toEqual(params);
      return jsonResponse({ data: credentials });
    });

    await expect(exchangeConnectAuthCode(params, {
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
    })).resolves.toEqual(credentials);
  });

  it.each(malformedCredentials)('rejects invalid exchange credentials %#', async (value) => {
    const fetchImplementation = vi.fn(async (): Promise<Response> => jsonResponse({ data: value }));

    await expect(exchangeConnectAuthCode({
      code: 'connect_auth_code_123',
      intentId: 'connect_intent_123',
      state: 'state_123',
    }, { fetch: fetchImplementation })).rejects.toThrow('Invalid Connect auth exchange response.');
  });

  it('renews using the refresh credential only and returns its replacement', async () => {
    const controller = new AbortController();
    const replacement: ConnectAuthCredentials = {
      ...credentials,
      session: { ...credentials.session, sessionId: 'connect_session_replacement' },
      refreshToken: 'connect_refresh_replacement',
    };
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);
      expect(request.url).toBe('https://rare-api.test/v1/connect/auth/refresh');
      expect(request.method).toBe('POST');
      expect(request.headers.get('content-type')).toBe('application/json');
      expect(request.headers.has('authorization')).toBe(false);
      expect(await request.json()).toEqual({ refreshToken: credentials.refreshToken });
      expect(init?.signal).toBe(controller.signal);
      return jsonResponse({ data: replacement });
    });

    await expect(refreshConnectAuthSession(credentials.refreshToken, {
      apiUrl: ' https://rare-api.test/// ',
      fetch: fetchImplementation,
      signal: controller.signal,
    })).resolves.toEqual(replacement);
  });

  it.each(malformedCredentials)('rejects invalid renewal credentials %#', async (value) => {
    const fetchImplementation = vi.fn(async (): Promise<Response> => jsonResponse({ data: value }));

    await expect(refreshConnectAuthSession(credentials.refreshToken, {
      fetch: fetchImplementation,
    })).rejects.toThrow('Invalid Connect auth refresh response.');
  });

  it('revokes the credential family through the logout endpoint without bearer auth', async () => {
    const controller = new AbortController();
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);
      expect(request.url).toBe('https://api.superrare.com/v1/connect/auth/logout');
      expect(request.method).toBe('POST');
      expect(request.headers.get('content-type')).toBe('application/json');
      expect(request.headers.has('authorization')).toBe(false);
      expect(await request.json()).toEqual({ refreshToken: credentials.refreshToken });
      expect(init?.signal).toBe(controller.signal);
      return jsonResponse({ data: { revoked: true } });
    });

    await expect(revokeConnectAuthSession(credentials.refreshToken, {
      fetch: fetchImplementation,
      signal: controller.signal,
    })).resolves.toBeUndefined();
  });

  it.each([
    {},
    { data: {} },
    { data: { revoked: false } },
    { data: { revoked: 'true' } },
    { revoked: true },
  ])('rejects an unconfirmed revocation response %#', async (value) => {
    const fetchImplementation = vi.fn(async (): Promise<Response> => jsonResponse(value));

    await expect(revokeConnectAuthSession(credentials.refreshToken, {
      fetch: fetchImplementation,
    })).rejects.toThrow('Invalid Connect auth logout response.');
  });

  describe.each([
    { name: 'refresh', path: '/v1/connect/auth/refresh', request: refreshConnectAuthSession },
    { name: 'logout', path: '/v1/connect/auth/logout', request: revokeConnectAuthSession },
  ])('$name failure handling', ({ path, request }) => {
    it.each([400, 401, 503])('preserves HTTP status %i and does not replay the credential', async (status) => {
      const message = status === 503 ? 'Connect storage unavailable' : 'Connect refresh credential is invalid';
      const fetchImplementation = vi.fn(async (): Promise<Response> =>
        jsonResponse({ error: message }, { status }),
      );
      const operation = request(credentials.refreshToken, { fetch: fetchImplementation });

      await expect(operation).rejects.toBeInstanceOf(SuperRareConnectApiError);
      await expect(operation).rejects.toMatchObject({ status, path });
      expect(fetchImplementation).toHaveBeenCalledTimes(1);
    });

    it('preserves network errors without silently retrying a potentially consumed credential', async () => {
      const networkError = new TypeError('Failed to fetch');
      const fetchImplementation = vi.fn(async (): Promise<Response> => { throw networkError; });

      await expect(request(credentials.refreshToken, {
        fetch: fetchImplementation,
      })).rejects.toBe(networkError);
      expect(fetchImplementation).toHaveBeenCalledTimes(1);
    });

    it('forwards an aborted request rather than replacing or retrying it', async () => {
      const controller = new AbortController();
      const abortError = new DOMException('The operation was aborted', 'AbortError');
      controller.abort(abortError);
      const fetchImplementation = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (init?.signal?.aborted) {
          throw init.signal.reason;
        }
        throw new Error('Expected the aborted signal to reach the transport.');
      });

      await expect(request(credentials.refreshToken, {
        fetch: fetchImplementation,
        signal: controller.signal,
      })).rejects.toBe(abortError);
      expect(fetchImplementation).toHaveBeenCalledTimes(1);
    });
  });

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

  it('parses intent status carrying a scheduled auction bid snapshot', async () => {
    const fetchImplementation = vi.fn(async (): Promise<Response> => jsonResponse({
      data: {
        intentId: 'connect_intent_scheduled_bid',
        type: 'bid',
        status: 'completed',
        returnPath: '/bid/complete',
        expiresAt: '2026-06-22T00:00:00.000Z',
        resolvedActionSnapshot: {
          actionKey: '1-0x1234567890123456789012345678901234567890-123',
          actionType: 'bid',
          resolvedAt: '2026-06-21T00:00:00.000Z',
          targetKind: 'erc721-scheduled-auction',
          terms: {
            available: true,
            amount: '1200000000000000000',
            currency: 'ETH',
            marketplace: '0x6D7c44773C52D396F43c2D511B81aa168E9a7a42',
            seller: '0x0000000000000000000000000000000000000001',
          },
        },
        result: { transactionHash: '0xtransaction' },
      },
    }));

    await expect(getConnectIntent({
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
      intentId: 'connect_intent_scheduled_bid',
    })).resolves.toMatchObject({
      intentId: 'connect_intent_scheduled_bid',
      type: 'bid',
      resolvedActionSnapshot: {
        targetKind: 'erc721-scheduled-auction',
        terms: { amount: '1200000000000000000' },
      },
    });
  });

  it('parses a liquid edition buy snapshot and keeps the quoted output terms', async () => {
    const liquidEditionBuySnapshot = {
      actionKey: '11155111-0x5547e40bab6f1e967f0031a53ea288dc22cbfa5a-liquid-buy-eth',
      actionType: 'buy',
      resolvedAt: '2026-09-30T00:00:00.000Z',
      targetKind: 'liquid-edition',
      terms: {
        available: true,
        amount: '10000000000000000',
        currency: 'ETH',
        outputCurrency: '0x5547E40bAb6f1e967F0031A53Ea288dC22cbFA5a',
        estimatedAmountOut: '176261894818424719784',
        minAmountOut: '175380585344332596185',
        marketplace: '0x429c3Ee66E7f6CDA12C5BadE4104aF3277aA2305',
      },
    };
    const fetchImplementation = vi.fn(async (): Promise<Response> => jsonResponse({
      data: {
        intentId: 'connect_intent_liquid_buy',
        type: 'buy',
        status: 'pending',
        returnPath: '/liquid/complete',
        expiresAt: '2026-09-30T00:15:00.000Z',
        resolvedActionSnapshot: liquidEditionBuySnapshot,
      },
    }));

    const intent = await getConnectIntent({
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
      intentId: 'connect_intent_liquid_buy',
    });

    expect(intent.resolvedActionSnapshot).toEqual(liquidEditionBuySnapshot);
  });

  it('parses a liquid edition sell intent and its checkout status snapshot', async () => {
    const liquidEditionSellSnapshot = {
      actionKey: '11155111-0x5547e40bab6f1e967f0031a53ea288dc22cbfa5a-liquid-sell-usdc',
      actionType: 'sell',
      resolvedAt: '2026-09-30T00:00:00.000Z',
      targetKind: 'liquid-edition',
      terms: {
        available: true,
        amount: '44065473704606179946',
        currency: '0x5547E40bAb6f1e967F0031A53Ea288dC22cbFA5a',
        outputCurrency: 'USDC',
        estimatedAmountOut: '68649863',
        minAmountOut: '68306625',
        marketplace: '0x429c3Ee66E7f6CDA12C5BadE4104aF3277aA2305',
      },
    };
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url.includes('/v1/connect/checkout/')) {
        return jsonResponse({
          data: {
            sessionId: 'connect_checkout_session_liquid',
            status: 'completed',
            intentId: 'connect_intent_liquid_sell',
            resolvedActionSnapshot: liquidEditionSellSnapshot,
            transactionHash: '0xtransaction',
          },
        });
      }

      return jsonResponse({
        data: {
          intentId: 'connect_intent_liquid_sell',
          type: 'sell',
          status: 'completed',
          returnPath: '/liquid/complete',
          expiresAt: '2026-09-30T00:15:00.000Z',
          resolvedActionSnapshot: liquidEditionSellSnapshot,
          result: { transactionHash: '0xtransaction' },
        },
      });
    });

    await expect(getConnectIntent({
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
      intentId: 'connect_intent_liquid_sell',
    })).resolves.toMatchObject({
      type: 'sell',
      resolvedActionSnapshot: liquidEditionSellSnapshot,
    });
    await expect(getConnectCheckoutStatus({
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
      sessionId: 'connect_checkout_session_liquid',
    })).resolves.toMatchObject({
      resolvedActionSnapshot: liquidEditionSellSnapshot,
    });
  });

  it('reads an intent whose action type and target kind this SDK does not know yet', async () => {
    const futureSnapshot = {
      actionKey: '1-0x1234567890123456789012345678901234567890-future',
      actionType: 'future-action',
      resolvedAt: '2026-09-30T00:00:00.000Z',
      targetKind: 'future-target',
      terms: { available: true },
    };
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url.includes('/v1/connect/checkout/')) {
        return jsonResponse({
          data: {
            sessionId: 'connect_checkout_session_future',
            status: 'completed',
            resolvedActionSnapshot: futureSnapshot,
          },
        });
      }

      return jsonResponse({
        data: {
          intentId: 'connect_intent_future',
          type: 'future-action',
          status: 'completed',
          returnPath: '/',
          expiresAt: '2026-09-30T00:15:00.000Z',
          resolvedActionSnapshot: futureSnapshot,
        },
      });
    });

    await expect(getConnectIntent({
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
      intentId: 'connect_intent_future',
    })).resolves.toMatchObject({
      type: 'future-action',
      status: 'completed',
      resolvedActionSnapshot: futureSnapshot,
    });
    await expect(getConnectCheckoutStatus({
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
      sessionId: 'connect_checkout_session_future',
    })).resolves.toMatchObject({
      resolvedActionSnapshot: futureSnapshot,
    });
  });

  it('still rejects an intent without an action type', async () => {
    const fetchImplementation = vi.fn(async (): Promise<Response> => jsonResponse({
      data: {
        intentId: 'connect_intent_malformed',
        type: '',
        status: 'completed',
        returnPath: '/',
        expiresAt: '2026-09-30T00:15:00.000Z',
      },
    }));

    await expect(getConnectIntent({
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
      intentId: 'connect_intent_malformed',
    })).rejects.toThrow('Invalid Connect intent response.');
  });

  it('parses a completed transfer intent and keeps the recipient and chain id in both status reads', async () => {
    const transferSnapshot = {
      actionKey: '11155111-0x52908400098527886E0F7030069857D2E4169EE7-transfer-USDC',
      actionType: 'transfer',
      resolvedAt: '2026-10-01T00:00:00.000Z',
      targetKind: 'wallet',
      terms: {
        available: true,
        amount: '25000000',
        chainId: 11155111,
        currency: 'USDC',
        recipient: '0x52908400098527886E0F7030069857D2E4169EE7',
      },
    };
    const transactionHash = '0x9b1f0c4f0a5d4a3c2a1b0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b';
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url.includes('/v1/connect/checkout/')) {
        return jsonResponse({
          data: {
            sessionId: 'connect_checkout_session_transfer',
            status: 'completed',
            intentId: 'connect_intent_transfer',
            resolvedActionSnapshot: transferSnapshot,
            transactionHash,
          },
        });
      }

      return jsonResponse({
        data: {
          intentId: 'connect_intent_transfer',
          type: 'transfer',
          status: 'completed',
          returnPath: '/credits/complete',
          expiresAt: '2026-10-01T00:15:00.000Z',
          resolvedActionSnapshot: transferSnapshot,
          result: { transactionHash },
        },
      });
    });

    await expect(getConnectIntent({
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
      intentId: 'connect_intent_transfer',
    })).resolves.toEqual({
      intentId: 'connect_intent_transfer',
      type: 'transfer',
      status: 'completed',
      returnPath: '/credits/complete',
      expiresAt: '2026-10-01T00:15:00.000Z',
      resolvedActionSnapshot: transferSnapshot,
      result: { transactionHash },
    });
    await expect(getConnectCheckoutStatus({
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
      sessionId: 'connect_checkout_session_transfer',
    })).resolves.toMatchObject({
      resolvedActionSnapshot: transferSnapshot,
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

  it('surfaces the message from an object-shaped error body instead of "Request failed"', async () => {
    // rare-api can answer a 400 whose `error` is an object (a serialized
    // ZodError), not a string. The reason must still reach the caller rather
    // than collapsing to the generic "Request failed" fallback.
    const fetchImplementation = vi.fn(async (): Promise<Response> =>
      jsonResponse(
        {
          success: false,
          error: {
            name: 'ZodError',
            message: '[{"code":"invalid_union","path":[],"message":"Invalid input"}]',
          },
        },
        { status: 400 },
      ),
    );

    await expect(getConnectIntent({
      intentId: 'connect_intent_123',
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
    })).rejects.toThrow('invalid_union');
  });

  it('still surfaces a plain string error body', async () => {
    const fetchImplementation = vi.fn(async (): Promise<Response> =>
      jsonResponse({ error: 'Reserve auction is unavailable' }, { status: 409 }),
    );

    await expect(getConnectIntent({
      intentId: 'connect_intent_123',
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
    })).rejects.toThrow('Reserve auction is unavailable');
  });
});

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json' },
  });
}
