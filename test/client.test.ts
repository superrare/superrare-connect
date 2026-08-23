import { describe, expect, it, vi } from 'vitest';
import {
  ConnectAuthCallbackError,
  ConnectAuthPendingError,
  createSuperRareClient,
  type ConnectNavigation,
} from '../src/client.js';
import type {
  ConnectErc1155CheckoutTarget,
  ConnectErc721BatchOfferTarget,
  ConnectErc721DirectListingTarget,
  ConnectErc721OfferTarget,
  ConnectErc721ReleaseTarget,
  ConnectErc721ReserveAuctionTarget,
} from '../src/auth-flow-core.js';
import type { SuperRareConnectApiError } from '../src/errors.js';
import type { ConnectPopupWindow } from '../src/popup-core.js';
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

const offerTarget: ConnectErc721OfferTarget = {
  kind: 'erc721-offer',
  chainId: 1,
  contract: '0x1234567890123456789012345678901234567890',
  tokenId: '123',
};

const batchOfferTarget: ConnectErc721BatchOfferTarget = {
  kind: 'erc721-batch-offer',
  chainId: 1,
  creator: '0x2222222222222222222222222222222222222222',
  root: '0xroot',
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

  it('starts settle intents through actions.settle and navigates to the hosted URL', async () => {
    const navigations: string[] = [];
    const navigation: ConnectNavigation = {
      assign(url) {
        navigations.push(url);
      },
    };
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      createState: () => 'state_settle',
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);

        expect(request.url).toBe('https://rare-api.test/v1/connect/intents');
        expect(await request.json()).toEqual({
          action: {
            type: 'settle',
            target: reserveAuctionTarget,
          },
          returnPath: '/settle/complete',
          state: 'state_settle',
        });

        return jsonResponse({
          data: {
            intentId: 'connect_intent_settle',
            url: 'https://connect.superrare.test/action/connect_intent_settle',
            expiresAt: '2026-06-22T00:00:00.000Z',
          },
        });
      },
      navigation,
      sessionStorage: false,
    });

    await expect(client.actions.settle({
      target: reserveAuctionTarget,
      returnPath: '/settle/complete',
    })).resolves.toMatchObject({
      intentId: 'connect_intent_settle',
      url: 'https://connect.superrare.test/action/connect_intent_settle',
    });
    expect(navigations).toEqual([
      'https://connect.superrare.test/action/connect_intent_settle',
    ]);
  });

  it('starts make, accept, and cancel offer intents through the offers namespace', async () => {
    const assignedUrls: string[] = [];
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      createState: () => 'state_offer',
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const body: unknown = await request.json();

        if (isConnectActionRequest(body, 'offer')) {
          expect(body).toEqual({
            action: {
              type: 'offer',
              target: offerTarget,
              offer: { currency: 'ETH', amount: '1.2' },
            },
            returnPath: '/offer/complete',
            state: 'state_offer',
          });
          return connectIntentCreationResponse('connect_intent_offer');
        }

        if (isConnectActionRequest(body, 'offer-accept')) {
          expect(body).toEqual({
            action: {
              type: 'offer-accept',
              target: offerTarget,
              expected: { currency: 'ETH', amount: '1.2' },
            },
            returnPath: '/offer/accept/complete',
            state: 'state_offer',
          });
          return connectIntentCreationResponse('connect_intent_offer_accept');
        }

        if (isConnectActionRequest(body, 'offer-cancel')) {
          expect(body).toEqual({
            action: {
              type: 'offer-cancel',
              target: batchOfferTarget,
            },
            returnPath: '/offer/cancel/complete',
            state: 'state_offer',
          });
          return connectIntentCreationResponse('connect_intent_offer_cancel');
        }

        throw new Error('Unexpected offer Connect request.');
      },
      navigation: {
        assign(url) {
          assignedUrls.push(url);
        },
      },
      sessionStorage: false,
    });

    await expect(client.offers.make({
      target: offerTarget,
      offer: { currency: 'ETH', amount: '1.2' },
      returnPath: '/offer/complete',
    })).resolves.toMatchObject({ intentId: 'connect_intent_offer' });
    await expect(client.offers.accept({
      target: offerTarget,
      expected: { currency: 'ETH', amount: '1.2' },
      returnPath: '/offer/accept/complete',
    })).resolves.toMatchObject({ intentId: 'connect_intent_offer_accept' });
    await expect(client.offers.cancel({
      target: batchOfferTarget,
      returnPath: '/offer/cancel/complete',
    })).resolves.toMatchObject({ intentId: 'connect_intent_offer_cancel' });

    expect(assignedUrls).toEqual([
      'https://connect.superrare.test/intents/connect_intent_offer',
      'https://connect.superrare.test/intents/connect_intent_offer_accept',
      'https://connect.superrare.test/intents/connect_intent_offer_cancel',
    ]);
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

  it('opens hosted intents in a sized popup and closes it once the intent settles', async () => {
    vi.useFakeTimers();
    try {
      const opened: Array<{ url: string; target: string; features: string }> = [];
      const replacedUrls: string[] = [];
      const assignedUrls: string[] = [];
      const settledStatuses: string[] = [];
      const popup: ConnectPopupWindow = {
        closed: false,
        close: () => {
          popup.closed = true;
        },
        location: {
          replace(url) {
            replacedUrls.push(url);
          },
        },
      };
      let statusRequests = 0;
      const client = createSuperRareClient({
        apiUrl: 'https://rare-api.test',
        createState: () => 'state_popup',
        display: 'popup',
        popup: {
          width: 400,
          height: 640,
          open: (url, target, features) => {
            opened.push({ url, target, features });
            return popup;
          },
        },
        onIntentSettled: (intent) => {
          settledStatuses.push(intent.status);
        },
        fetch: async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);

          if (request.method === 'GET') {
            statusRequests += 1;
            return jsonResponse({
              data: {
                intentId: 'connect_intent_buy',
                type: 'buy',
                status: statusRequests < 2 ? 'requires_user' : 'completed',
                returnPath: '/buy/complete',
                expiresAt: '2026-06-22T00:00:00.000Z',
              },
            });
          }

          return connectIntentCreationResponse('connect_intent_buy');
        },
        navigation: {
          assign(url) {
            assignedUrls.push(url);
          },
        },
        sessionStorage: false,
      });

      await expect(client.actions.buy({
        target: directListingTarget,
        expected: { currency: 'ETH', price: '1.2' },
        returnPath: '/buy/complete',
      })).resolves.toMatchObject({ intentId: 'connect_intent_buy' });

      expect(opened).toHaveLength(1);
      expect(opened[0]?.url).toBe('about:blank');
      expect(opened[0]?.target).toBe('superrare-connect');
      expect(opened[0]?.features).toContain('popup=yes');
      expect(opened[0]?.features).toContain('width=400');
      expect(opened[0]?.features).toContain('height=640');
      // The popup navigates with the display marker; the page does not redirect.
      expect(replacedUrls).toEqual([
        'https://connect.superrare.test/intents/connect_intent_buy?display=popup',
      ]);
      expect(assignedUrls).toEqual([]);

      await vi.advanceTimersByTimeAsync(2000);
      expect(popup.closed).toBe(false);
      expect(settledStatuses).toEqual([]);

      await vi.advanceTimersByTimeAsync(2000);
      expect(popup.closed).toBe(true);
      expect(settledStatuses).toEqual(['completed']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the latest intent state when the user closes the popup early', async () => {
    vi.useFakeTimers();
    try {
      const settledStatuses: string[] = [];
      const popup: ConnectPopupWindow = {
        closed: false,
        close: () => {
          popup.closed = true;
        },
        location: { replace: () => undefined },
      };
      const client = createSuperRareClient({
        apiUrl: 'https://rare-api.test',
        createState: () => 'state_popup',
        display: 'popup',
        popup: { open: () => popup },
        onIntentSettled: (intent) => {
          settledStatuses.push(intent.status);
        },
        fetch: async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);

          if (request.method === 'GET') {
            return jsonResponse({
              data: {
                intentId: 'connect_intent_buy',
                type: 'buy',
                status: 'requires_user',
                returnPath: '/buy/complete',
                expiresAt: '2026-06-22T00:00:00.000Z',
              },
            });
          }

          return connectIntentCreationResponse('connect_intent_buy');
        },
        navigation: false,
        sessionStorage: false,
      });

      await client.actions.buy({
        target: directListingTarget,
        expected: { currency: 'ETH', price: '1.2' },
        returnPath: '/buy/complete',
      });

      popup.closed = true;
      await vi.advanceTimersByTimeAsync(2000);
      expect(settledStatuses).toEqual(['requires_user']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses to navigate to a non-web intent URL in popup and redirect modes', async () => {
    // The hosted URL comes from Rare API, but it is the last thing standing
    // between the SDK and a real navigation: an executable URL must never
    // reach location.replace or location.assign.
    const executableIntentResponse = (): Response => jsonResponse({
      data: {
        intentId: 'connect_intent_buy',
        url: 'javascript:alert(1)',
        expiresAt: '2026-06-22T00:00:00.000Z',
      },
    });
    const buyParams = {
      target: directListingTarget,
      expected: { currency: 'ETH', price: '1.2' },
      returnPath: '/buy/complete',
    } as const;

    const replacedUrls: string[] = [];
    const popup: ConnectPopupWindow = {
      closed: false,
      close(): void {
        popup.closed = true;
      },
      location: {
        replace(url: string): void {
          replacedUrls.push(url);
        },
      },
    };
    const popupClient = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      createState: () => 'state_popup',
      display: 'popup',
      popup: { open: () => popup },
      fetch: async () => executableIntentResponse(),
      navigation: false,
      sessionStorage: false,
    });

    await expect(popupClient.actions.buy(buyParams)).rejects.toThrow('Invalid Connect intent URL.');
    expect(replacedUrls).toEqual([]);
    expect(popup.closed).toBe(true);

    const assignedUrls: string[] = [];
    const redirectClient = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      createState: () => 'state_redirect',
      fetch: async () => executableIntentResponse(),
      navigation: {
        assign(url) {
          assignedUrls.push(url);
        },
      },
      sessionStorage: false,
    });

    await expect(redirectClient.actions.buy(buyParams)).rejects.toThrow('Invalid Connect intent URL.');
    expect(assignedUrls).toEqual([]);
  });

  it('refuses a non-web login intent URL without storing pending auth', async () => {
    const storage = createMemoryStorage();
    const assignedUrls: string[] = [];
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      createState: () => 'state_login',
      fetch: async () => jsonResponse({
        data: {
          intentId: 'connect_intent_login',
          url: 'data:text/html,<script>alert(1)</script>',
          expiresAt: '2027-01-01T00:00:00.000Z',
        },
      }),
      navigation: {
        assign(url) {
          assignedUrls.push(url);
        },
      },
      sessionStorage: storage,
    });

    await expect(client.auth.login({ returnPath: '/account' })).rejects.toThrow('Invalid Connect intent URL.');
    expect(assignedUrls).toEqual([]);
    expect(storage.getItem('superrare.connect.pendingAuth')).toBeNull();
  });

  it('falls back to redirect navigation when the popup is blocked', async () => {
    const assignedUrls: string[] = [];
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      createState: () => 'state_popup',
      display: 'popup',
      popup: { open: () => null },
      fetch: async () => connectIntentCreationResponse('connect_intent_buy'),
      navigation: {
        assign(url) {
          assignedUrls.push(url);
        },
      },
      sessionStorage: false,
    });

    await client.actions.buy({
      target: directListingTarget,
      expected: { currency: 'ETH', price: '1.2' },
      returnPath: '/buy/complete',
    });

    expect(assignedUrls).toEqual([
      'https://connect.superrare.test/intents/connect_intent_buy',
    ]);
  });
});

describe('auth.loginWithPopup', () => {
  type EmittedMessage = { origin: string; data: unknown };

  function createMessageEmitter(): {
    messageEvents: { subscribe: (listener: (event: EmittedMessage) => void) => () => void };
    emit: (event: EmittedMessage) => void;
    listenerCount: () => number;
  } {
    const listeners = new Set<(event: EmittedMessage) => void>();

    return {
      messageEvents: {
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
      emit(event) {
        listeners.forEach((listener) => {
          listener(event);
        });
      },
      listenerCount: () => listeners.size,
    };
  }

  function createPopupStub(): ConnectPopupWindow & { replacedUrls: string[] } {
    const replacedUrls: string[] = [];
    const popup = {
      closed: false,
      replacedUrls,
      close(): void {
        popup.closed = true;
      },
      location: {
        replace(url: string): void {
          replacedUrls.push(url);
        },
      },
    };
    return popup;
  }

  function loginIntentCreationResponse(): Response {
    return jsonResponse({
      data: {
        intentId: 'connect_intent_login',
        url: 'https://connect.superrare.test/login?intentId=connect_intent_login',
        expiresAt: '2027-01-01T00:00:00.000Z',
      },
    });
  }

  it('exchanges the posted callback, stores the session, and resolves with the user', async () => {
    const storage = createMemoryStorage();
    const popup = createPopupStub();
    const emitter = createMessageEmitter();
    const requestedPaths: string[] = [];
    const sessionChanges: Array<string | undefined> = [];
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      createState: () => 'state_login',
      popup: { open: () => popup, messageEvents: emitter.messageEvents },
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requestedPaths.push(new URL(request.url).pathname);

        if (request.url.endsWith('/v1/connect/auth/exchange')) {
          expect(await request.json()).toEqual({
            intentId: 'connect_intent_login',
            state: 'state_login',
            code: 'connect_auth_code_login',
          });
          return jsonResponse({
            data: {
              session: {
                sessionId: 'connect_session_login',
                userId: 'user_login',
                address: '0x0000000000000000000000000000000000000009',
                expiresAt: '2027-01-01T00:00:00.000Z',
              },
            },
          });
        }

        if (request.url.endsWith('/v1/connect/users/me')) {
          expect(request.headers.get('Authorization')).toBe('Bearer connect_session_login');
          return jsonResponse({
            data: {
              address: '0x0000000000000000000000000000000000000009',
              username: 'collector',
              fullName: 'Collector One',
              avatarUri: null,
            },
          });
        }

        return loginIntentCreationResponse();
      },
      navigation: false,
      sessionStorage: storage,
    });
    client.auth.onChange((session) => {
      sessionChanges.push(session?.sessionId);
    });

    const resultPromise = client.auth.loginWithPopup({ returnPath: '/auth/callback' });
    await vi.waitFor(() => {
      expect(popup.replacedUrls).toHaveLength(1);
    });
    expect(popup.replacedUrls).toEqual([
      'https://connect.superrare.test/login?intentId=connect_intent_login&display=popup',
    ]);

    // Foreign-origin and unrelated messages are ignored.
    emitter.emit({
      origin: 'https://evil.test',
      data: {
        type: 'superrare-connect:auth-callback',
        intentId: 'connect_intent_login',
        state: 'state_login',
        code: 'stolen',
      },
    });
    emitter.emit({ origin: 'https://connect.superrare.test', data: { type: 'other' } });

    emitter.emit({
      origin: 'https://connect.superrare.test',
      data: {
        type: 'superrare-connect:auth-callback',
        intentId: 'connect_intent_login',
        state: 'state_login',
        code: 'connect_auth_code_login',
      },
    });

    const result = await resultPromise;
    expect(result.status).toBe('authenticated');
    if (result.status !== 'authenticated') throw new Error('unreachable');
    expect(result.session.sessionId).toBe('connect_session_login');
    expect(result.session.address).toBe('0x0000000000000000000000000000000000000009');
    expect(result.user?.username).toBe('collector');
    expect(popup.closed).toBe(true);
    expect(emitter.listenerCount()).toBe(0);
    expect(client.auth.getSession()?.sessionId).toBe('connect_session_login');
    expect(storage.getItem('superrare.connect.pendingAuth')).toBeNull();
    expect(sessionChanges).toEqual(['connect_session_login']);
    expect(requestedPaths).toEqual([
      '/v1/connect/intents',
      '/v1/connect/auth/exchange',
      '/v1/connect/users/me',
    ]);
  });

  it('still resolves authenticated when the profile lookup fails', async () => {
    const popup = createPopupStub();
    const emitter = createMessageEmitter();
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      createState: () => 'state_login',
      popup: { open: () => popup, messageEvents: emitter.messageEvents },
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);

        if (request.url.endsWith('/v1/connect/auth/exchange')) {
          return jsonResponse({
            data: {
              session: {
                sessionId: 'connect_session_login',
                userId: 'user_login',
                address: '0x0000000000000000000000000000000000000009',
                expiresAt: '2027-01-01T00:00:00.000Z',
              },
            },
          });
        }

        if (request.url.endsWith('/v1/connect/users/me')) {
          return jsonResponse({ error: 'boom' }, { status: 500 });
        }

        return loginIntentCreationResponse();
      },
      navigation: false,
      sessionStorage: createMemoryStorage(),
    });

    const resultPromise = client.auth.loginWithPopup();
    await vi.waitFor(() => {
      expect(popup.replacedUrls).toHaveLength(1);
    });
    emitter.emit({
      origin: 'https://connect.superrare.test',
      data: {
        type: 'superrare-connect:auth-callback',
        intentId: 'connect_intent_login',
        state: 'state_login',
        code: 'connect_auth_code_login',
      },
    });

    const result = await resultPromise;
    expect(result).toMatchObject({ status: 'authenticated', user: undefined });
  });

  it('resolves cancelled when the popup is closed before completing', async () => {
    vi.useFakeTimers();
    try {
      const storage = createMemoryStorage();
      const popup = createPopupStub();
      const emitter = createMessageEmitter();
      const client = createSuperRareClient({
        apiUrl: 'https://rare-api.test',
        createState: () => 'state_login',
        popup: { open: () => popup, messageEvents: emitter.messageEvents },
        fetch: async () => loginIntentCreationResponse(),
        navigation: false,
        sessionStorage: storage,
      });

      const resultPromise = client.auth.loginWithPopup();
      await vi.waitFor(() => {
        expect(popup.replacedUrls).toHaveLength(1);
      });
      // A popup login verifies against its own in-memory record, so it never
      // writes the shared key that redirect logins own.
      expect(storage.getItem('superrare.connect.pendingAuth')).toBeNull();
      popup.closed = true;
      await vi.advanceTimersByTimeAsync(2000);

      await expect(resultPromise).resolves.toEqual({ status: 'cancelled' });
      expect(emitter.listenerCount()).toBe(0);
      // A cancelled popup releases its pending record: nothing can complete it.
      expect(storage.getItem('superrare.connect.pendingAuth')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves expired once the login intent deadline passes', async () => {
    vi.useFakeTimers();
    try {
      const popup = createPopupStub();
      const emitter = createMessageEmitter();
      const client = createSuperRareClient({
        apiUrl: 'https://rare-api.test',
        createState: () => 'state_login',
        popup: { open: () => popup, messageEvents: emitter.messageEvents },
        fetch: async () => jsonResponse({
          data: {
            intentId: 'connect_intent_login',
            url: 'https://connect.superrare.test/login?intentId=connect_intent_login',
            expiresAt: '2020-01-01T00:00:00.000Z',
          },
        }),
        navigation: false,
        sessionStorage: createMemoryStorage(),
      });

      const resultPromise = client.auth.loginWithPopup();
      await vi.waitFor(() => {
        expect(popup.replacedUrls).toHaveLength(1);
      });
      await vi.advanceTimersByTimeAsync(2000);

      await expect(resultPromise).resolves.toEqual({ status: 'expired' });
      expect(popup.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects and closes the popup when the callback does not match the pending auth', async () => {
    const popup = createPopupStub();
    const emitter = createMessageEmitter();
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      createState: () => 'state_login',
      popup: { open: () => popup, messageEvents: emitter.messageEvents },
      fetch: async () => loginIntentCreationResponse(),
      navigation: false,
      sessionStorage: createMemoryStorage(),
    });

    const resultPromise = client.auth.loginWithPopup();
    await vi.waitFor(() => {
      expect(popup.replacedUrls).toHaveLength(1);
    });
    emitter.emit({
      origin: 'https://connect.superrare.test',
      data: {
        type: 'superrare-connect:auth-callback',
        intentId: 'connect_intent_login',
        state: 'state_other',
        code: 'connect_auth_code_login',
      },
    });

    await expect(resultPromise).rejects.toMatchObject({ code: 'state_mismatch' });
    expect(popup.closed).toBe(true);
    expect(emitter.listenerCount()).toBe(0);
  });

  it('falls back to redirect login when the popup is blocked', async () => {
    const emitter = createMessageEmitter();
    const assignedUrls: string[] = [];
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      createState: () => 'state_login',
      popup: { open: () => null, messageEvents: emitter.messageEvents },
      fetch: async () => loginIntentCreationResponse(),
      navigation: {
        assign(url) {
          assignedUrls.push(url);
        },
      },
      sessionStorage: createMemoryStorage(),
    });

    const result = await client.auth.loginWithPopup();
    expect(result).toMatchObject({
      status: 'redirected',
      intent: { intentId: 'connect_intent_login' },
    });
    expect(assignedUrls).toEqual([
      'https://connect.superrare.test/login?intentId=connect_intent_login',
    ]);
  });

  const authCallbackMessage = {
    type: 'superrare-connect:auth-callback',
    intentId: 'connect_intent_login',
    state: 'state_login',
    code: 'connect_auth_code_login',
  };

  const sessionResponse = (): Response => jsonResponse({
    data: {
      session: {
        sessionId: 'connect_session_login',
        userId: 'user_login',
        address: '0x0000000000000000000000000000000000000009',
        expiresAt: '2027-01-01T00:00:00.000Z',
      },
    },
  });

  it('completes with browser storage disabled by verifying the callback against its own pending record', async () => {
    const popup = createPopupStub();
    const emitter = createMessageEmitter();
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      createState: () => 'state_login',
      popup: { open: () => popup, messageEvents: emitter.messageEvents },
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (request.url.endsWith('/v1/connect/auth/exchange')) return sessionResponse();
        if (request.url.endsWith('/v1/connect/users/me')) return jsonResponse({ error: 'nope' }, { status: 500 });
        return loginIntentCreationResponse();
      },
      navigation: false,
      sessionStorage: false,
    });

    const resultPromise = client.auth.loginWithPopup();
    await vi.waitFor(() => {
      expect(popup.replacedUrls).toHaveLength(1);
    });
    emitter.emit({ origin: 'https://connect.superrare.test', data: authCallbackMessage });

    await expect(resultPromise).resolves.toMatchObject({
      status: 'authenticated',
      session: { sessionId: 'connect_session_login' },
    });
  });

  it('joins the login already in flight instead of starting a second one', async () => {
    // The SDK holds a single session, so two concurrent logins could only
    // race for the same slot. A second call joins the first.
    const popup = createPopupStub();
    const emitter = createMessageEmitter();
    const openedTargets: string[] = [];
    let intentRequests = 0;
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      createState: () => 'state_login',
      popup: {
        open: (_url, target) => {
          openedTargets.push(target);
          return popup;
        },
        messageEvents: emitter.messageEvents,
      },
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (request.url.endsWith('/v1/connect/auth/exchange')) return sessionResponse();
        if (request.url.endsWith('/v1/connect/users/me')) return jsonResponse({ error: 'nope' }, { status: 500 });
        intentRequests += 1;
        return loginIntentCreationResponse();
      },
      navigation: false,
      sessionStorage: createMemoryStorage(),
    });

    const firstPromise = client.auth.loginWithPopup();
    const secondPromise = client.auth.loginWithPopup();
    await vi.waitFor(() => {
      expect(popup.replacedUrls).toHaveLength(1);
    });

    // One window, one intent — the second call opened nothing.
    expect(openedTargets).toHaveLength(1);
    expect(intentRequests).toBe(1);

    emitter.emit({ origin: 'https://connect.superrare.test', data: authCallbackMessage });
    const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);
    expect(firstResult).toMatchObject({ status: 'authenticated' });
    expect(secondResult).toBe(firstResult);
  });

  it('releases the in-flight login once it settles', async () => {
    vi.useFakeTimers();
    try {
      const emitter = createMessageEmitter();
      const popups: Array<ReturnType<typeof createPopupStub>> = [];
      const client = createSuperRareClient({
        apiUrl: 'https://rare-api.test',
        createState: () => 'state_login',
        popup: {
          open: () => {
            const openedPopup = createPopupStub();
            popups.push(openedPopup);
            return openedPopup;
          },
          messageEvents: emitter.messageEvents,
        },
        fetch: async () => loginIntentCreationResponse(),
        navigation: false,
        sessionStorage: createMemoryStorage(),
      });

      const firstPromise = client.auth.loginWithPopup();
      await vi.waitFor(() => {
        expect(popups).toHaveLength(1);
      });
      popups[0]!.closed = true;
      await vi.advanceTimersByTimeAsync(2000);
      await expect(firstPromise).resolves.toEqual({ status: 'cancelled' });

      // The lock is gone: a later login starts its own window.
      const secondPromise = client.auth.loginWithPopup();
      await vi.waitFor(() => {
        expect(popups).toHaveLength(2);
      });
      popups[1]!.closed = true;
      await vi.advanceTimersByTimeAsync(2000);
      await expect(secondPromise).resolves.toEqual({ status: 'cancelled' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels when the popup is closed while the intent is still being created', async () => {
    vi.useFakeTimers();
    try {
      const storage = createMemoryStorage();
      const popup = createPopupStub();
      const emitter = createMessageEmitter();
      const client = createSuperRareClient({
        apiUrl: 'https://rare-api.test',
        createState: () => 'state_login',
        popup: { open: () => popup, messageEvents: emitter.messageEvents },
        // The intent request never settles: nothing else can end this login.
        fetch: async () => await new Promise<Response>(() => {}),
        navigation: false,
        sessionStorage: storage,
      });

      const resultPromise = client.auth.loginWithPopup();
      await vi.advanceTimersByTimeAsync(0);
      // Closed before the login watcher exists — the gap this covers.
      popup.closed = true;
      await vi.advanceTimersByTimeAsync(2000);

      await expect(resultPromise).resolves.toEqual({ status: 'cancelled' });
      expect(popup.replacedUrls).toEqual([]);
      expect(storage.getItem('superrare.connect.pendingAuth')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('forwards an abort signal to every request the caller waits on', async () => {
    // The timeouts are only real if the signal actually reaches fetch.
    const popup = createPopupStub();
    const emitter = createMessageEmitter();
    const signalsByPath = new Map<string, AbortSignal | null | undefined>();
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      createState: () => 'state_login',
      popup: { open: () => popup, messageEvents: emitter.messageEvents },
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        signalsByPath.set(new URL(request.url).pathname, init?.signal);
        if (request.url.endsWith('/v1/connect/auth/exchange')) return sessionResponse();
        if (request.url.endsWith('/v1/connect/users/me')) {
          return jsonResponse({
            data: {
              address: '0x0000000000000000000000000000000000000009',
              username: 'collector',
              fullName: null,
              avatarUri: null,
            },
          });
        }

        return loginIntentCreationResponse();
      },
      navigation: false,
      sessionStorage: createMemoryStorage(),
    });

    const resultPromise = client.auth.loginWithPopup();
    await vi.waitFor(() => {
      expect(popup.replacedUrls).toHaveLength(1);
    });
    emitter.emit({ origin: 'https://connect.superrare.test', data: authCallbackMessage });
    await expect(resultPromise).resolves.toMatchObject({ status: 'authenticated' });

    for (const path of [
      '/v1/connect/intents',
      '/v1/connect/auth/exchange',
      '/v1/connect/users/me',
    ]) {
      expect(signalsByPath.get(path)).toBeInstanceOf(AbortSignal);
    }
  });

  it('times out a completion the backend never answers', async () => {
    vi.useFakeTimers();
    try {
      const storage = createMemoryStorage();
      const popup = createPopupStub();
      const emitter = createMessageEmitter();
      const sessionChanges: Array<string | undefined> = [];
      let releaseExchange: (() => void) | undefined;
      const client = createSuperRareClient({
        apiUrl: 'https://rare-api.test',
        createState: () => 'state_login',
        popup: { open: () => popup, messageEvents: emitter.messageEvents },
        fetch: async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);
          if (request.url.endsWith('/v1/connect/auth/exchange')) {
            await new Promise<void>((resolve) => {
              releaseExchange = resolve;
            });
            return sessionResponse();
          }

          return loginIntentCreationResponse();
        },
        navigation: false,
        sessionStorage: storage,
      });
      client.auth.onChange((session) => {
        sessionChanges.push(session?.sessionId);
      });

      const resultPromise = client.auth.loginWithPopup();
      // Capture the outcome now: the rejection lands while the test is still
      // advancing timers, and an unobserved rejection is reported as an
      // unhandled error. Real callers await the call immediately.
      const outcome = resultPromise.catch((error: unknown) => error);
      // Advance rather than vi.waitFor: with fake timers, waitFor polls on a
      // faked timer nobody is advancing and deadlocks.
      await vi.advanceTimersByTimeAsync(0);
      expect(popup.replacedUrls).toHaveLength(1);

      emitter.emit({ origin: 'https://connect.superrare.test', data: authCallbackMessage });
      await vi.advanceTimersByTimeAsync(0);
      expect(releaseExchange).toBeDefined();

      // The hosted window already closed itself, so only the clock can end
      // this: without it the caller would wait forever.
      await vi.advanceTimersByTimeAsync(21_000);
      await expect(outcome).resolves.toMatchObject({
        message: 'Timed out completing the Connect login.',
      });

      // A response that lands after the timeout must not write a session.
      releaseExchange?.();
      await vi.advanceTimersByTimeAsync(100);
      expect(client.auth.getSession()).toBeUndefined();
      expect(sessionChanges).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a stale exchange when the session changed while it was in flight', async () => {
    const storage = createMemoryStorage();
    const popup = createPopupStub();
    const emitter = createMessageEmitter();
    let releaseExchange: (() => void) | undefined;
    const sessionChanges: Array<string | undefined> = [];
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      createState: () => 'state_login',
      popup: { open: () => popup, messageEvents: emitter.messageEvents },
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (request.url.endsWith('/v1/connect/auth/exchange')) {
          await new Promise<void>((resolve) => {
            releaseExchange = resolve;
          });
          return sessionResponse();
        }
        return loginIntentCreationResponse();
      },
      navigation: false,
      sessionStorage: storage,
    });
    client.auth.onChange((session) => {
      sessionChanges.push(session?.sessionId);
    });

    const resultPromise = client.auth.loginWithPopup();
    await vi.waitFor(() => {
      expect(popup.replacedUrls).toHaveLength(1);
    });
    emitter.emit({ origin: 'https://connect.superrare.test', data: authCallbackMessage });
    await vi.waitFor(() => {
      expect(releaseExchange).toBeDefined();
    });

    // The user logs out while the exchange is still pending.
    client.auth.logout();
    releaseExchange?.();

    await expect(resultPromise).resolves.toEqual({ status: 'cancelled' });
    expect(client.auth.getSession()).toBeUndefined();
    expect(sessionChanges).toEqual([undefined]);
    expect(storage.getItem('superrare.connect.pendingAuth')).toBeNull();
  });

  it('resolves expired for a callback that arrives after the deadline', async () => {
    const popup = createPopupStub();
    const emitter = createMessageEmitter();
    const exchangeRequests: string[] = [];
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      createState: () => 'state_login',
      popup: { open: () => popup, messageEvents: emitter.messageEvents },
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (request.url.endsWith('/v1/connect/auth/exchange')) {
          exchangeRequests.push(request.url);
          return sessionResponse();
        }
        return jsonResponse({
          data: {
            intentId: 'connect_intent_login',
            url: 'https://connect.superrare.test/login?intentId=connect_intent_login',
            expiresAt: '2020-01-01T00:00:00.000Z',
          },
        });
      },
      navigation: false,
      sessionStorage: createMemoryStorage(),
    });

    const resultPromise = client.auth.loginWithPopup();
    await vi.waitFor(() => {
      expect(popup.replacedUrls).toHaveLength(1);
    });
    emitter.emit({ origin: 'https://connect.superrare.test', data: authCallbackMessage });

    await expect(resultPromise).resolves.toEqual({ status: 'expired' });
    expect(exchangeRequests).toEqual([]);
    expect(popup.closed).toBe(true);
  });

  it('falls back to a bounded deadline when the intent expiry is unparseable', async () => {
    vi.useFakeTimers();
    try {
      const popup = createPopupStub();
      const emitter = createMessageEmitter();
      const client = createSuperRareClient({
        apiUrl: 'https://rare-api.test',
        createState: () => 'state_login',
        popup: { open: () => popup, messageEvents: emitter.messageEvents },
        fetch: async () => jsonResponse({
          data: {
            intentId: 'connect_intent_login',
            url: 'https://connect.superrare.test/login?intentId=connect_intent_login',
            expiresAt: 'not-a-date',
          },
        }),
        navigation: false,
        sessionStorage: createMemoryStorage(),
      });

      const resultPromise = client.auth.loginWithPopup();
      await vi.waitFor(() => {
        expect(popup.replacedUrls).toHaveLength(1);
      });
      await vi.advanceTimersByTimeAsync(14 * 60_000);
      expect(popup.closed).toBe(false);
      await vi.advanceTimersByTimeAsync(2 * 60_000);

      await expect(resultPromise).resolves.toEqual({ status: 'expired' });
      expect(popup.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a newer redirect login\'s pending record when a popup login commits', async () => {
    const storage = createMemoryStorage();
    const popup = createPopupStub();
    const emitter = createMessageEmitter();
    const states = ['state_first', 'state_second'];
    const assignedUrls: string[] = [];
    let intentCount = 0;
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      createState: () => states.shift() ?? 'state_extra',
      popup: { open: () => popup, messageEvents: emitter.messageEvents },
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (request.url.endsWith('/v1/connect/auth/exchange')) return sessionResponse();
        if (request.url.endsWith('/v1/connect/users/me')) return jsonResponse({ error: 'nope' }, { status: 500 });
        intentCount += 1;
        const intentId = intentCount === 1 ? 'connect_intent_first' : 'connect_intent_second';
        return jsonResponse({
          data: {
            intentId,
            url: `https://connect.superrare.test/login?intentId=${intentId}`,
            expiresAt: '2027-01-01T00:00:00.000Z',
          },
        });
      },
      navigation: {
        assign(url) {
          assignedUrls.push(url);
        },
      },
      sessionStorage: storage,
    });

    const popupPromise = client.auth.loginWithPopup();
    await vi.waitFor(() => {
      expect(popup.replacedUrls).toHaveLength(1);
    });
    // A redirect login starts before the popup callback lands; its pending
    // record is now the stored one.
    await client.auth.login({ returnPath: '/account' });
    expect(assignedUrls).toHaveLength(1);

    emitter.emit({
      origin: 'https://connect.superrare.test',
      data: { ...authCallbackMessage, intentId: 'connect_intent_first', state: 'state_first' },
    });
    await expect(popupPromise).resolves.toMatchObject({ status: 'authenticated' });

    // The popup commit must not have consumed the redirect login's record.
    expect(storage.getItem('superrare.connect.pendingAuth')).toBe(JSON.stringify({
      intentId: 'connect_intent_second',
      state: 'state_second',
      expiresAt: '2027-01-01T00:00:00.000Z',
    }));
    await expect(client.auth.exchangeCallback(new URLSearchParams({
      intentId: 'connect_intent_second',
      state: 'state_second',
      code: 'connect_auth_code_login',
    }))).resolves.toMatchObject({ sessionId: 'connect_session_login' });
  });

  it('drops the login when logout happens before the callback arrives', async () => {
    const popup = createPopupStub();
    const emitter = createMessageEmitter();
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      createState: () => 'state_login',
      popup: { open: () => popup, messageEvents: emitter.messageEvents },
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (request.url.endsWith('/v1/connect/auth/exchange')) return sessionResponse();
        return loginIntentCreationResponse();
      },
      navigation: false,
      sessionStorage: createMemoryStorage(),
    });

    const resultPromise = client.auth.loginWithPopup();
    await vi.waitFor(() => {
      expect(popup.replacedUrls).toHaveLength(1);
    });
    client.auth.logout();
    emitter.emit({ origin: 'https://connect.superrare.test', data: authCallbackMessage });

    await expect(resultPromise).resolves.toEqual({ status: 'cancelled' });
    expect(client.auth.getSession()).toBeUndefined();
  });

  it('drops the login when logout happens during the profile lookup', async () => {
    const popup = createPopupStub();
    const emitter = createMessageEmitter();
    let releaseProfile: (() => void) | undefined;
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      createState: () => 'state_login',
      popup: { open: () => popup, messageEvents: emitter.messageEvents },
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (request.url.endsWith('/v1/connect/auth/exchange')) return sessionResponse();
        if (request.url.endsWith('/v1/connect/users/me')) {
          await new Promise<void>((resolve) => {
            releaseProfile = resolve;
          });
          return jsonResponse({
            data: {
              address: '0x0000000000000000000000000000000000000009',
              username: 'collector',
              fullName: null,
              avatarUri: null,
            },
          });
        }
        return loginIntentCreationResponse();
      },
      navigation: false,
      sessionStorage: createMemoryStorage(),
    });

    const resultPromise = client.auth.loginWithPopup();
    await vi.waitFor(() => {
      expect(popup.replacedUrls).toHaveLength(1);
    });
    emitter.emit({ origin: 'https://connect.superrare.test', data: authCallbackMessage });
    await vi.waitFor(() => {
      expect(releaseProfile).toBeDefined();
    });

    client.auth.logout();
    releaseProfile?.();

    await expect(resultPromise).resolves.toEqual({ status: 'cancelled' });
    expect(client.auth.getSession()).toBeUndefined();
  });

  it('gives each client instance its own named browsing context', async () => {
    const openedTargets: string[] = [];
    const openedPopups: Array<ReturnType<typeof createPopupStub>> = [];
    const emitter = createMessageEmitter();
    const buildClient = (): ReturnType<typeof createSuperRareClient> =>
      createSuperRareClient({
        apiUrl: 'https://rare-api.test',
        createState: () => 'state_login',
        popup: {
          open: (_url, target) => {
            openedTargets.push(target);
            const openedPopup = createPopupStub();
            openedPopups.push(openedPopup);
            return openedPopup;
          },
          messageEvents: emitter.messageEvents,
        },
        fetch: async () => loginIntentCreationResponse(),
        navigation: false,
        sessionStorage: createMemoryStorage(),
      });

    // Serialization is per client, so two clients on one page can still have
    // a login each — they must not share a window name.
    const firstPromise = buildClient().auth.loginWithPopup();
    const secondPromise = buildClient().auth.loginWithPopup();
    await vi.waitFor(() => {
      expect(openedTargets).toHaveLength(2);
    });

    expect(new Set(openedTargets).size).toBe(2);

    // Settle both so neither watcher outlives the test.
    openedPopups.forEach((openedPopup) => {
      openedPopup.closed = true;
    });
    await expect(firstPromise).resolves.toEqual({ status: 'cancelled' });
    await expect(secondPromise).resolves.toEqual({ status: 'cancelled' });
  });

  it('refuses the redirect fallback when the popup is blocked and storage is disabled', async () => {
    const emitter = createMessageEmitter();
    const assignedUrls: string[] = [];
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      createState: () => 'state_login',
      popup: { open: () => null, messageEvents: emitter.messageEvents },
      fetch: async () => loginIntentCreationResponse(),
      navigation: {
        assign(url) {
          assignedUrls.push(url);
        },
      },
      sessionStorage: false,
    });

    // Redirecting would strand the user: the callback could never verify.
    await expect(client.auth.loginWithPopup()).rejects.toThrow(
      'requires session storage',
    );
    expect(assignedUrls).toEqual([]);
  });

  it('refuses to navigate a popup to a non-web intent URL', async () => {
    const storage = createMemoryStorage();
    const popup = createPopupStub();
    const emitter = createMessageEmitter();
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      createState: () => 'state_login',
      popup: { open: () => popup, messageEvents: emitter.messageEvents },
      fetch: async () => jsonResponse({
        data: {
          intentId: 'connect_intent_login',
          url: 'javascript:alert(1)',
          expiresAt: '2027-01-01T00:00:00.000Z',
        },
      }),
      navigation: false,
      sessionStorage: storage,
    });

    await expect(client.auth.loginWithPopup()).rejects.toThrow('Invalid Connect intent URL.');
    expect(popup.replacedUrls).toEqual([]);
    expect(popup.closed).toBe(true);
    expect(storage.getItem('superrare.connect.pendingAuth')).toBeNull();
  });

  it('leaves an in-flight redirect login\'s pending record untouched', async () => {
    const storage = createMemoryStorage();
    const popup = createPopupStub();
    const emitter = createMessageEmitter();
    const states = ['state_redirect', 'state_popup'];
    let intentCount = 0;
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      createState: () => states.shift() ?? 'state_extra',
      popup: { open: () => popup, messageEvents: emitter.messageEvents },
      fetch: async () => {
        intentCount += 1;
        const intentId = intentCount === 1 ? 'connect_intent_redirect' : 'connect_intent_popup';
        return jsonResponse({
          data: {
            intentId,
            url: `https://connect.superrare.test/login?intentId=${intentId}`,
            expiresAt: '2027-01-01T00:00:00.000Z',
          },
        });
      },
      navigation: { assign() {} },
      sessionStorage: storage,
    });

    // A redirect login is awaiting its callback...
    await client.auth.login({ returnPath: '/account' });
    const redirectPending = storage.getItem('superrare.connect.pendingAuth');

    // ...and a popup login starts alongside it.
    const popupPromise = client.auth.loginWithPopup();
    await vi.waitFor(() => {
      expect(popup.replacedUrls).toHaveLength(1);
    });

    expect(storage.getItem('superrare.connect.pendingAuth')).toBe(redirectPending);

    popup.closed = true;
    await expect(popupPromise).resolves.toEqual({ status: 'cancelled' });
    // Cancelling the popup must not consume the redirect login's record.
    expect(storage.getItem('superrare.connect.pendingAuth')).toBe(redirectPending);
  });

  it('cancels the blocked-popup fallback when logout lands while the intent is created', async () => {
    const storage = createMemoryStorage();
    const emitter = createMessageEmitter();
    const assignedUrls: string[] = [];
    let releaseIntent: (() => void) | undefined;
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      createState: () => 'state_login',
      popup: { open: () => null, messageEvents: emitter.messageEvents },
      fetch: async () => {
        await new Promise<void>((resolve) => {
          releaseIntent = resolve;
        });
        return loginIntentCreationResponse();
      },
      navigation: {
        assign(url) {
          assignedUrls.push(url);
        },
      },
      sessionStorage: storage,
    });

    const resultPromise = client.auth.loginWithPopup();
    await vi.waitFor(() => {
      expect(releaseIntent).toBeDefined();
    });
    client.auth.logout();
    releaseIntent?.();

    await expect(resultPromise).resolves.toEqual({ status: 'cancelled' });
    expect(assignedUrls).toEqual([]);
    expect(storage.getItem('superrare.connect.pendingAuth')).toBeNull();
  });

  it('does not let a late redirect exchange overwrite a committed popup session', async () => {
    const storage = createMemoryStorage();
    storage.setItem('superrare.connect.pendingAuth', JSON.stringify({
      intentId: 'connect_intent_redirect',
      state: 'state_redirect',
      expiresAt: '2027-01-01T00:00:00.000Z',
    }));
    const popup = createPopupStub();
    const emitter = createMessageEmitter();
    let releaseRedirectExchange: (() => void) | undefined;
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      createState: () => 'state_login',
      popup: { open: () => popup, messageEvents: emitter.messageEvents },
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (request.url.endsWith('/v1/connect/auth/exchange')) {
          const body: unknown = await request.json();
          const isRedirect =
            typeof body === 'object' && body !== null && 'state' in body &&
            body.state === 'state_redirect';
          if (isRedirect) {
            await new Promise<void>((resolve) => {
              releaseRedirectExchange = resolve;
            });
            return jsonResponse({
              data: {
                session: {
                  sessionId: 'connect_session_redirect',
                  userId: 'user_redirect',
                  address: '0x0000000000000000000000000000000000000001',
                  expiresAt: '2027-01-01T00:00:00.000Z',
                },
              },
            });
          }
          return sessionResponse();
        }
        if (request.url.endsWith('/v1/connect/users/me')) return jsonResponse({ error: 'nope' }, { status: 500 });
        return loginIntentCreationResponse();
      },
      navigation: false,
      sessionStorage: storage,
    });

    // A redirect exchange is in flight...
    const redirectPromise = client.auth.exchangeCallback(new URLSearchParams({
      intentId: 'connect_intent_redirect',
      state: 'state_redirect',
      code: 'connect_auth_code_redirect',
    }));
    await vi.waitFor(() => {
      expect(releaseRedirectExchange).toBeDefined();
    });

    // ...while a popup login completes.
    const popupPromise = client.auth.loginWithPopup();
    await vi.waitFor(() => {
      expect(popup.replacedUrls).toHaveLength(1);
    });
    emitter.emit({ origin: 'https://connect.superrare.test', data: authCallbackMessage });
    await expect(popupPromise).resolves.toMatchObject({ status: 'authenticated' });

    releaseRedirectExchange?.();
    await expect(redirectPromise).resolves.toMatchObject({ sessionId: 'connect_session_redirect' });
    // The newer popup login stands; the late exchange did not clobber it.
    expect(client.auth.getSession()?.sessionId).toBe('connect_session_login');
  });

  it('releases the popup and pending record when popup navigation throws', async () => {
    const storage = createMemoryStorage();
    const emitter = createMessageEmitter();
    const popup = createPopupStub();
    popup.location.replace = (): never => {
      throw new Error('navigation blocked');
    };
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      createState: () => 'state_login',
      popup: { open: () => popup, messageEvents: emitter.messageEvents },
      fetch: async () => loginIntentCreationResponse(),
      navigation: false,
      sessionStorage: storage,
    });

    await expect(client.auth.loginWithPopup()).rejects.toThrow('navigation blocked');
    expect(popup.closed).toBe(true);
    expect(storage.getItem('superrare.connect.pendingAuth')).toBeNull();
    expect(emitter.listenerCount()).toBe(0);
  });

  it('releases the popup and pending record when the intent URL is malformed', async () => {
    const storage = createMemoryStorage();
    const popup = createPopupStub();
    const emitter = createMessageEmitter();
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      createState: () => 'state_login',
      popup: { open: () => popup, messageEvents: emitter.messageEvents },
      fetch: async () => jsonResponse({
        data: {
          intentId: 'connect_intent_login',
          url: 'not a url',
          expiresAt: '2027-01-01T00:00:00.000Z',
        },
      }),
      navigation: false,
      sessionStorage: storage,
    });

    await expect(client.auth.loginWithPopup()).rejects.toThrow('Invalid Connect intent URL.');
    expect(popup.closed).toBe(true);
    expect(popup.replacedUrls).toEqual([]);
    expect(storage.getItem('superrare.connect.pendingAuth')).toBeNull();
    expect(emitter.listenerCount()).toBe(0);
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
  type: 'checkout' | 'buy' | 'bid' | 'mint' | 'offer' | 'offer-accept' | 'offer-cancel',
): value is { action: { type: 'checkout' | 'buy' | 'bid' | 'mint' | 'offer' | 'offer-accept' | 'offer-cancel' } } {
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
