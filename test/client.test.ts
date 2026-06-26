import { describe, expect, it, vi } from 'vitest';
import {
  ConnectAuthCallbackError,
  ConnectAuthPendingError,
  createSuperRareClient,
  type ConnectNavigation,
} from '../src/client.js';
import type {
  ConnectErc1155CheckoutTarget,
  ConnectErc721DirectListingTarget,
  ConnectErc721ReleaseTarget,
  ConnectErc721ReserveAuctionTarget,
} from '../src/auth-flow-core.js';
import type { SuperRareConnectApiError } from '../src/errors.js';
import type { ConnectSessionStorage } from '../src/session-storage-core.js';

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

describe('createSuperRareClient', () => {
  it('creates hosted login intents, stores pending auth, and navigates to the hosted URL', async () => {
    const storage = createMemoryStorage();
    const assignedUrls: string[] = [];
    const navigation: ConnectNavigation = {
      assign(url) {
        assignedUrls.push(url);
      },
    };
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
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      createState: () => 'state_123',
      fetch: fetchImplementation,
      initiatingOrigin: 'https://artist.example',
      navigation,
      sessionStorage: storage,
    });

    await expect(client.auth.login({ returnPath: '/account' })).resolves.toEqual({
      intentId: 'connect_intent_123',
      url: 'https://connect.superrare.test/login?intentId=connect_intent_123',
      expiresAt: '2026-06-22T00:00:00.000Z',
    });
    expect(storage.getItem('superrare.connect.pendingAuth')).toBe(JSON.stringify({
      intentId: 'connect_intent_123',
      state: 'state_123',
      expiresAt: '2026-06-22T00:00:00.000Z',
    }));
    expect(assignedUrls).toEqual([
      'https://connect.superrare.test/login?intentId=connect_intent_123',
    ]);
  });

  it('exchanges hosted callback params and stores the Connect session', async () => {
    const storage = createMemoryStorage();
    storage.setItem('superrare.connect.pendingAuth', JSON.stringify({
      intentId: 'connect_intent_123',
      state: 'state_123',
      expiresAt: '2026-06-22T00:00:00.000Z',
    }));
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);

      expect(request.method).toBe('POST');
      expect(request.url).toBe('https://rare-api.test/v1/connect/auth/exchange');
      expect(await request.json()).toEqual({
        intentId: 'connect_intent_123',
        state: 'state_123',
        code: 'connect_auth_code_123',
      });

      return jsonResponse({
        data: {
          session: {
            sessionId: 'connect_session_123',
            userId: 'user_123',
            address: '0x0000000000000000000000000000000000000001',
            expiresAt: '2026-06-22T00:00:00.000Z',
          },
        },
      });
    });
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
      sessionStorage: storage,
    });

    const session = await client.auth.exchangeCallback(new URLSearchParams({
      intentId: 'connect_intent_123',
      state: 'state_123',
      code: 'connect_auth_code_123',
    }));

    expect(session.sessionId).toBe('connect_session_123');
    expect(client.auth.getSession()).toEqual(session);
    expect(storage.getItem('superrare.connect.pendingAuth')).toBeNull();
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it('rejects malformed callbacks before calling the API', async () => {
    const fetchImplementation = vi.fn(async (): Promise<Response> => jsonResponse({ data: {} }));
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
      sessionStorage: false,
    });

    await expect(client.auth.exchangeCallback(new URLSearchParams({
      intentId: 'connect_intent_123',
      state: 'state_123',
    }))).rejects.toThrow(ConnectAuthCallbackError);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('rejects callbacks that do not match pending auth before calling the API', async () => {
    const storage = createMemoryStorage();
    storage.setItem('superrare.connect.pendingAuth', JSON.stringify({
      intentId: 'connect_intent_123',
      state: 'state_123',
      expiresAt: '2026-06-22T00:00:00.000Z',
    }));
    const fetchImplementation = vi.fn(async (): Promise<Response> => jsonResponse({ data: {} }));
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
      sessionStorage: storage,
    });

    await expect(client.auth.exchangeCallback(new URLSearchParams({
      intentId: 'connect_intent_123',
      state: 'state_different',
      code: 'connect_auth_code_123',
    }))).rejects.toThrow(ConnectAuthPendingError);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it.each([400, 401, 404, 410] as const)('surfaces exchange API status %s', async (status) => {
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      fetch: async () => jsonResponse({ error: 'invalid connect auth exchange' }, { status }),
      sessionStorage: false,
    });

    await expect(client.auth.exchangeCode({
      intentId: 'connect_intent_123',
      state: 'state_123',
      code: 'connect_auth_code_123',
    })).rejects.toMatchObject({
      name: 'SuperRareConnectApiError',
      status,
      path: '/v1/connect/auth/exchange',
    } satisfies Partial<SuperRareConnectApiError>);
  });

  it('clears stored Connect sessions', async () => {
    const storage = createMemoryStorage();
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      fetch: async () => jsonResponse({
        data: {
          session: {
            sessionId: 'connect_session_123',
            userId: 'user_123',
            address: '0x0000000000000000000000000000000000000001',
            expiresAt: '2026-06-22T00:00:00.000Z',
          },
        },
      }),
      sessionStorage: storage,
    });

    await client.auth.exchangeCode({
      intentId: 'connect_intent_123',
      state: 'state_123',
      code: 'connect_auth_code_123',
    });
    client.auth.clearSession();

    expect(client.auth.getSession()).toBeUndefined();
  });

  it('notifies auth listeners when sessions change and unsubscribe stops future calls', async () => {
    const listener = vi.fn();
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      fetch: async () => jsonResponse({
        data: {
          session: {
            sessionId: 'connect_session_123',
            userId: 'user_123',
            address: '0x0000000000000000000000000000000000000001',
            expiresAt: '2026-06-22T00:00:00.000Z',
          },
        },
      }),
      sessionStorage: createMemoryStorage(),
    });

    const unsubscribe = client.auth.onChange(listener);

    await client.auth.exchangeCode({
      intentId: 'connect_intent_123',
      state: 'state_123',
      code: 'connect_auth_code_123',
    });
    client.auth.logout();
    unsubscribe();
    await client.auth.exchangeCode({
      intentId: 'connect_intent_123',
      state: 'state_123',
      code: 'connect_auth_code_123',
    });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls).toEqual([
      [expect.objectContaining({ sessionId: 'connect_session_123' })],
      [undefined],
    ]);
  });

  it('aliases logout to local session clearing', async () => {
    const storage = createMemoryStorage();
    storage.setItem('superrare.connect.session', JSON.stringify({
      sessionId: 'connect_session_123',
      userId: 'user_123',
      address: '0x0000000000000000000000000000000000000001',
      expiresAt: '2026-06-22T00:00:00.000Z',
    }));
    const client = createSuperRareClient({
      sessionStorage: storage,
    });

    client.auth.logout();

    expect(client.auth.getSession()).toBeUndefined();
  });

  it('gets remote session state with the stored local session', async () => {
    const storage = createMemoryStorage();
    storage.setItem('superrare.connect.session', JSON.stringify({
      sessionId: 'connect_session_123',
      userId: 'user_123',
      address: '0x0000000000000000000000000000000000000001',
      expiresAt: '2026-06-22T00:00:00.000Z',
    }));
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);

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
      },
      sessionStorage: storage,
    });

    await expect(client.auth.getRemoteSession()).resolves.toMatchObject({
      authenticated: true,
    });
  });

  it('gets current user with the stored local session', async () => {
    const storage = createMemoryStorage();
    storage.setItem('superrare.connect.session', JSON.stringify({
      sessionId: 'connect_session_123',
      userId: 'user_123',
      address: '0x0000000000000000000000000000000000000001',
      expiresAt: '2026-06-22T00:00:00.000Z',
    }));
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);

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
      },
      sessionStorage: storage,
    });

    await expect(client.auth.me()).resolves.toEqual({
      address: '0x0000000000000000000000000000000000000001',
      username: 'artist',
      fullName: 'Artist Name',
      avatarUri: null,
    });
  });

  it('exposes user.me as the public user namespace', async () => {
    const storage = createMemoryStorage();
    storage.setItem('superrare.connect.session', JSON.stringify({
      sessionId: 'connect_session_123',
      userId: 'user_123',
      address: '0x0000000000000000000000000000000000000001',
      expiresAt: '2026-06-22T00:00:00.000Z',
    }));
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      fetch: async () => jsonResponse({
        data: {
          address: '0x0000000000000000000000000000000000000001',
          username: 'artist',
          fullName: 'Artist Name',
          avatarUri: null,
        },
      }),
      sessionStorage: storage,
    });

    await expect(client.user.me()).resolves.toMatchObject({
      username: 'artist',
    });
  });

  it('starts checkout intents through checkout.start', async () => {
    const assignedUrls: string[] = [];
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      connectUrl: 'https://connect.staging.test',
      createState: () => 'state_checkout',
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);

        expect(request.url).toBe('https://rare-api.test/v1/connect/intents');
        expect(await request.json()).toEqual({
          action: {
            type: 'checkout',
            target: checkoutTarget,
          },
          returnPath: '/thanks',
          state: 'state_checkout',
        });

        return jsonResponse({
          data: {
            intentId: 'connect_intent_checkout',
            url: 'https://connect.superrare.test/action/connect_intent_checkout/start?executionSessionId=execution_session_123',
            expiresAt: '2026-06-22T00:00:00.000Z',
          },
        });
      },
      navigation: {
        assign(url) {
          assignedUrls.push(url);
        },
      },
      sessionStorage: false,
    });

    await expect(client.checkout.start({
      target: checkoutTarget,
      returnPath: '/thanks',
    })).resolves.toMatchObject({
      intentId: 'connect_intent_checkout',
      url: 'https://connect.staging.test/action/connect_intent_checkout/start?executionSessionId=execution_session_123',
    });
    expect(assignedUrls).toEqual([
      'https://connect.staging.test/action/connect_intent_checkout/start?executionSessionId=execution_session_123',
    ]);
  });

  it('replaces backend local hosted URL origin and clears the backend port', async () => {
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      connectUrl: 'https://connect-com-bc4d-784573620320.us-east1.run.app',
      createState: () => 'state_buy',
      fetch: async () => jsonResponse({
        data: {
          intentId: 'connect_intent_b6e82512-1318-4a61-89d0-9cda854eae15',
          url: 'https://0.0.0.0:3000/action/connect_intent_b6e82512-1318-4a61-89d0-9cda854eae15',
          expiresAt: '2026-06-22T00:00:00.000Z',
        },
      }),
      navigation: false,
      sessionStorage: false,
    });

    await expect(client.actions.buy({
      target: directListingTarget,
      expected: { currency: 'ETH', price: '1000000000000' },
      returnPath: '/buy/complete',
    })).resolves.toMatchObject({
      intentId: 'connect_intent_b6e82512-1318-4a61-89d0-9cda854eae15',
      url: 'https://connect-com-bc4d-784573620320.us-east1.run.app/action/connect_intent_b6e82512-1318-4a61-89d0-9cda854eae15',
    });
  });

  it('starts bid intents through actions.bid', async () => {
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      createState: () => 'state_bid',
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);

        expect(await request.json()).toEqual({
          action: {
            type: 'bid',
            target: reserveAuctionTarget,
            bid: { currency: 'ETH', amount: '1.2' },
          },
          returnPath: '/bid/complete',
          state: 'state_bid',
        });

        return jsonResponse({
          data: {
            intentId: 'connect_intent_bid',
            url: 'https://connect.superrare.test/action/connect_intent_bid',
            expiresAt: '2026-06-22T00:00:00.000Z',
          },
        });
      },
      navigation: false,
      sessionStorage: false,
    });

    await expect(client.actions.bid({
      target: reserveAuctionTarget,
      bid: { currency: 'ETH', amount: '1.2' },
      returnPath: '/bid/complete',
    })).resolves.toMatchObject({
      intentId: 'connect_intent_bid',
    });
  });

  it('supports anonymous checkout, actions, and intent status without a Connect session', async () => {
    const requestedUrls: string[] = [];
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      createState: () => 'state_anonymous',
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requestedUrls.push(request.url);
        expect(request.headers.get('authorization')).toBeNull();

        if (request.method === 'GET') {
          expect(request.url).toBe('https://rare-api.test/v1/connect/intents/connect_intent_bid');
          return jsonResponse({
            data: {
              intentId: 'connect_intent_bid',
              type: 'bid',
              status: 'pending',
              returnPath: '/bid/complete',
              expiresAt: '2026-06-22T00:00:00.000Z',
            },
          });
        }

        const body: unknown = await request.json();
        if (isConnectActionRequest(body, 'checkout')) {
          expect(body).toEqual({
            action: {
              type: 'checkout',
              target: checkoutTarget,
            },
            returnPath: '/checkout/complete',
            state: 'state_anonymous',
          });
          return connectIntentCreationResponse('connect_intent_checkout');
        }

        if (isConnectActionRequest(body, 'buy')) {
          expect(body).toEqual({
            action: {
              type: 'buy',
              target: directListingTarget,
              expected: { currency: 'ETH', price: '1.2' },
            },
            returnPath: '/buy/complete',
            state: 'state_anonymous',
          });
          return connectIntentCreationResponse('connect_intent_buy');
        }

        if (isConnectActionRequest(body, 'bid')) {
          expect(body).toEqual({
            action: {
              type: 'bid',
              target: reserveAuctionTarget,
              bid: { currency: 'ETH', amount: '1.2' },
            },
            returnPath: '/bid/complete',
            state: 'state_anonymous',
          });
          return connectIntentCreationResponse('connect_intent_bid');
        }

        if (isConnectActionRequest(body, 'mint')) {
          expect(body).toEqual({
            action: {
              type: 'mint',
              target: releaseTarget,
              purchase: { quantity: '2', currency: 'ETH', unitPrice: '0.5' },
            },
            returnPath: '/mint/complete',
            state: 'state_anonymous',
          });
          return connectIntentCreationResponse('connect_intent_mint');
        }

        throw new Error('Unexpected anonymous Connect request.');
      },
      navigation: false,
      sessionStorage: false,
    });

    await expect(client.checkout.start({
      target: checkoutTarget,
      returnPath: '/checkout/complete',
    })).resolves.toMatchObject({ intentId: 'connect_intent_checkout' });
    await expect(client.actions.buy({
      target: directListingTarget,
      expected: { currency: 'ETH', price: '1.2' },
      returnPath: '/buy/complete',
    })).resolves.toMatchObject({ intentId: 'connect_intent_buy' });
    await expect(client.actions.bid({
      target: reserveAuctionTarget,
      bid: { currency: 'ETH', amount: '1.2' },
      returnPath: '/bid/complete',
    })).resolves.toMatchObject({ intentId: 'connect_intent_bid' });
    await expect(client.actions.mint({
      target: releaseTarget,
      purchase: { quantity: '2', currency: 'ETH', unitPrice: '0.5' },
      returnPath: '/mint/complete',
    })).resolves.toMatchObject({ intentId: 'connect_intent_mint' });
    await expect(client.actions.getStatus({
      intentId: 'connect_intent_bid',
    })).resolves.toMatchObject({ status: 'pending' });

    expect(requestedUrls).toEqual([
      'https://rare-api.test/v1/connect/intents',
      'https://rare-api.test/v1/connect/intents',
      'https://rare-api.test/v1/connect/intents',
      'https://rare-api.test/v1/connect/intents',
      'https://rare-api.test/v1/connect/intents/connect_intent_bid',
    ]);
  });
});

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json' },
  });
}

function connectIntentCreationResponse(intentId: string): Response {
  return jsonResponse({
    data: {
      intentId,
      url: `https://connect.superrare.test/intents/${intentId}`,
      expiresAt: '2026-06-22T00:00:00.000Z',
    },
  });
}

function isConnectActionRequest(
  value: unknown,
  type: 'checkout' | 'buy' | 'bid' | 'mint',
): value is { action: { type: 'checkout' | 'buy' | 'bid' | 'mint' } } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'action' in value &&
    typeof value.action === 'object' &&
    value.action !== null &&
    'type' in value.action &&
    value.action.type === type
  );
}

function createMemoryStorage(): ConnectSessionStorage {
  const values = new Map<string, string>();

  return {
    getItem(key): string | null {
      return values.get(key) ?? null;
    },
    setItem(key, value): void {
      values.set(key, value);
    },
    removeItem(key): void {
      values.delete(key);
    },
  };
}
