import { describe, expect, it, vi } from 'vitest';
import {
  ConnectPopupBlockedError,
  createSuperRareClient,
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
import type { ConnectIntent } from '../src/status-core.js';
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

// Relative to the clock so tests never expire an intent on a fixed future
// date (the deadline logic compares expiresAt against Date.now()).
const futureExpiry = (): string => new Date(Date.now() + 30 * 60_000).toISOString();

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
      expiresAt: futureExpiry(),
    },
  });
}

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

// A terminal poll answer for any intent watcher, so action tests running on
// fake timers can settle their watcher with one 2s advance instead of
// leaking a polling loop past the test.
function completedIntentStatusResponse(request: Request): Response {
  return jsonResponse({
    data: {
      intentId: new URL(request.url).pathname.split('/').pop() ?? 'connect_intent',
      type: 'buy',
      status: 'completed',
      returnPath: '/',
      expiresAt: futureExpiry(),
    },
  });
}

describe('createSuperRareClient', () => {
  it('clears stored Connect sessions', async () => {
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

    client.auth.clearSession();

    expect(client.auth.getSession()).toBeUndefined();
    expect(storage.getItem('superrare.connect.session')).toBeNull();
  });

  it('notifies auth listeners when sessions change and unsubscribe stops future calls', async () => {
    const listener = vi.fn();
    const emitter = createMessageEmitter();
    const popups: Array<ReturnType<typeof createPopupStub>> = [];
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      createState: () => 'state_login',
      popup: {
        open: () => {
          const popup = createPopupStub();
          popups.push(popup);
          return popup;
        },
        messageEvents: emitter.messageEvents,
      },
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (request.url.endsWith('/v1/connect/auth/exchange')) return sessionResponse();
        if (request.url.endsWith('/v1/connect/users/me')) return jsonResponse({ error: 'nope' }, { status: 500 });
        return loginIntentCreationResponse();
      },
      sessionStorage: createMemoryStorage(),
    });

    const unsubscribe = client.auth.onChange(listener);

    const completeLogin = async (): Promise<void> => {
      const resultPromise = client.auth.login();
      await vi.waitFor(() => {
        expect(popups[popups.length - 1]?.replacedUrls).toHaveLength(1);
      });
      emitter.emit({ origin: 'https://connect.superrare.test', data: authCallbackMessage });
      await resultPromise;
    };

    await completeLogin();
    client.auth.logout();
    unsubscribe();
    await completeLogin();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls).toEqual([
      [expect.objectContaining({ sessionId: 'connect_session_login' })],
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

  it('starts checkout intents through checkout.start and opens them in their window', async () => {
    vi.useFakeTimers();
    try {
      const popup = createPopupStub();
      const client = createSuperRareClient({
        apiUrl: 'https://rare-api.test',
        connectUrl: 'https://connect.staging.test',
        createState: () => 'state_checkout',
        popup: { open: () => popup },
        fetch: async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);
          if (request.method === 'GET') return completedIntentStatusResponse(request);

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
        sessionStorage: false,
      });

      await expect(client.checkout.start({
        target: checkoutTarget,
        returnPath: '/thanks',
      })).resolves.toMatchObject({
        intentId: 'connect_intent_checkout',
        url: 'https://connect.staging.test/action/connect_intent_checkout/start?executionSessionId=execution_session_123',
      });
      expect(popup.replacedUrls).toEqual([
        'https://connect.staging.test/action/connect_intent_checkout/start?executionSessionId=execution_session_123&display=popup',
      ]);

      await vi.advanceTimersByTimeAsync(2000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces backend local hosted URL origin and clears the backend port', async () => {
    vi.useFakeTimers();
    try {
      const client = createSuperRareClient({
        apiUrl: 'https://rare-api.test',
        connectUrl: 'https://connect-com-bc4d-784573620320.us-east1.run.app',
        createState: () => 'state_buy',
        popup: { open: () => createPopupStub() },
        fetch: async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);
          if (request.method === 'GET') return completedIntentStatusResponse(request);
          return jsonResponse({
            data: {
              intentId: 'connect_intent_b6e82512-1318-4a61-89d0-9cda854eae15',
              url: 'https://0.0.0.0:3000/action/connect_intent_b6e82512-1318-4a61-89d0-9cda854eae15',
              expiresAt: '2026-06-22T00:00:00.000Z',
            },
          });
        },
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

      await vi.advanceTimersByTimeAsync(2000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts bid intents through actions.bid', async () => {
    vi.useFakeTimers();
    try {
      const client = createSuperRareClient({
        apiUrl: 'https://rare-api.test',
        createState: () => 'state_bid',
        popup: { open: () => createPopupStub() },
        fetch: async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);
          if (request.method === 'GET') return completedIntentStatusResponse(request);

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
        sessionStorage: false,
      });

      await expect(client.actions.bid({
        target: reserveAuctionTarget,
        bid: { currency: 'ETH', amount: '1.2' },
        returnPath: '/bid/complete',
      })).resolves.toMatchObject({
        intentId: 'connect_intent_bid',
      });

      await vi.advanceTimersByTimeAsync(2000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts settle intents through actions.settle and opens the hosted URL in its window', async () => {
    vi.useFakeTimers();
    try {
      const popup = createPopupStub();
      const client = createSuperRareClient({
        apiUrl: 'https://rare-api.test',
        createState: () => 'state_settle',
        popup: { open: () => popup },
        fetch: async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);
          if (request.method === 'GET') return completedIntentStatusResponse(request);

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
        sessionStorage: false,
      });

      await expect(client.actions.settle({
        target: reserveAuctionTarget,
        returnPath: '/settle/complete',
      })).resolves.toMatchObject({
        intentId: 'connect_intent_settle',
        url: 'https://connect.superrare.test/action/connect_intent_settle',
      });
      expect(popup.replacedUrls).toEqual([
        'https://connect.superrare.test/action/connect_intent_settle?display=popup',
      ]);

      await vi.advanceTimersByTimeAsync(2000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts make, accept, and cancel offer intents through the offers namespace', async () => {
    vi.useFakeTimers();
    try {
    const replacedUrls: string[] = [];
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      createState: () => 'state_offer',
      popup: {
        open: () => {
          const popup = createPopupStub();
          const recordingPopup = {
            ...popup,
            location: {
              replace(url: string): void {
                replacedUrls.push(url);
              },
            },
          };
          return recordingPopup;
        },
      },
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (request.method === 'GET') return completedIntentStatusResponse(request);
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

    expect(replacedUrls).toEqual([
      'https://connect.superrare.test/intents/connect_intent_offer?display=popup',
      'https://connect.superrare.test/intents/connect_intent_offer_accept?display=popup',
      'https://connect.superrare.test/intents/connect_intent_offer_cancel?display=popup',
    ]);

    await vi.advanceTimersByTimeAsync(2000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('supports anonymous checkout, actions, and intent status without a Connect session', async () => {
    vi.useFakeTimers();
    try {
    const requestedUrls: string[] = [];
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      createState: () => 'state_anonymous',
      popup: { open: () => createPopupStub() },
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requestedUrls.push(request.url);
        expect(request.headers.get('authorization')).toBeNull();

        if (request.method === 'GET') {
          // Watcher polls for the other intents arrive after the assertions;
          // a terminal answer settles each watcher.
          if (!request.url.endsWith('/connect_intent_bid')) {
            return completedIntentStatusResponse(request);
          }
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

    await vi.advanceTimersByTimeAsync(2000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens hosted intents in a sized popup and closes it once the intent settles', async () => {
    vi.useFakeTimers();
    try {
      const opened: Array<{ url: string; target: string; features: string }> = [];
      const replacedUrls: string[] = [];
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
        sessionStorage: false,
      });

      await expect(client.actions.buy({
        target: directListingTarget,
        expected: { currency: 'ETH', price: '1.2' },
        returnPath: '/buy/complete',
      })).resolves.toMatchObject({ intentId: 'connect_intent_buy' });

      expect(opened).toHaveLength(1);
      expect(opened[0]?.url).toBe('about:blank');
      // Each action popup gets its own window name so a second action cannot
      // reuse (and its watcher close) the window of the first.
      expect(opened[0]?.target).toMatch(/^superrare-connect-intent-.+/);
      expect(opened[0]?.features).toContain('popup=yes');
      expect(opened[0]?.features).toContain('width=400');
      expect(opened[0]?.features).toContain('height=640');
      // The popup navigates with the display marker.
      expect(replacedUrls).toEqual([
        'https://connect.superrare.test/intents/connect_intent_buy?display=popup',
      ]);

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

  it('refuses to navigate to a non-web intent URL', async () => {
    // The hosted URL comes from Rare API, but it is the last thing standing
    // between the SDK and a real navigation: an executable URL must never
    // reach location.replace.
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
      popup: { open: () => popup },
      fetch: async () => executableIntentResponse(),
      sessionStorage: false,
    });

    await expect(popupClient.actions.buy(buyParams)).rejects.toThrow('Invalid Connect intent URL');
    expect(replacedUrls).toEqual([]);
    expect(popup.closed).toBe(true);
  });

  it('stops watching an action popup once the intent can no longer change', async () => {
    // Regression: the watcher used to poll forever. A buyer who walks away with
    // the window open kept the integrator's page hitting Rare API every 2s.
    vi.useFakeTimers();
    try {
      let statusRequests = 0;
      let pollsWithoutDeadline = 0;
      const popup: ConnectPopupWindow = {
        closed: false,
        close: () => {
          popup.closed = true;
        },
        location: { replace: () => undefined },
      };
      const settled: ConnectIntent[] = [];
      const client = createSuperRareClient({
        apiUrl: 'https://rare-api.test',
        createState: () => 'state_popup',
        onIntentSettled: (intent) => {
          settled.push(intent);
        },
        popup: { open: () => popup },
        fetch: async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);

          if (request.method === 'GET') {
            statusRequests += 1;
            // Each poll must carry its own request deadline; one hung fetch
            // otherwise stalls the whole watcher.
            if (!(init?.signal instanceof AbortSignal)) pollsWithoutDeadline += 1;
            return jsonResponse({
              data: {
                intentId: 'connect_intent_buy',
                type: 'buy',
                status: 'requires_user',
                returnPath: '/buy/complete',
                // Already expired: the deadline plus its grace is in the past.
                expiresAt: '2020-01-01T00:00:00.000Z',
              },
            });
          }

          return jsonResponse({
            data: {
              intentId: 'connect_intent_buy',
              url: 'https://connect.superrare.test/intents/connect_intent_buy',
              expiresAt: '2020-01-01T00:00:00.000Z',
            },
          });
        },
        sessionStorage: false,
      });

      await client.actions.buy({
        target: directListingTarget,
        expected: { currency: 'ETH', price: '1.2' },
        returnPath: '/buy/complete',
      });

      // An unparseable/past expiry falls back to a bounded window, so the
      // watcher runs — but it does not run forever.
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      const requestsAfterDeadline = statusRequests;
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(statusRequests).toBe(requestsAfterDeadline);
      // Only a KNOWN terminal outcome closes the buyer's window; a fallback
      // stop leaves it to the hosted page, which may be mid-payment.
      expect(popup.closed).toBe(false);
      // The documented deadline contract: the integrator hears about the stop,
      // and the payload can be non-terminal — their code must check status.
      expect(settled).toHaveLength(1);
      expect(settled[0]?.status).toBe('requires_user');
      expect(pollsWithoutDeadline).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops watching when the intent can no longer be read', async () => {
    vi.useFakeTimers();
    try {
      let statusRequests = 0;
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
        popup: { open: () => popup },
        fetch: async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);

          if (request.method === 'GET') {
            statusRequests += 1;
            // Gone for good: retrying cannot make it readable.
            return jsonResponse({ error: 'Connect intent not found' }, { status: 404 });
          }

          return connectIntentCreationResponse('connect_intent_buy');
        },
        sessionStorage: false,
      });

      await client.actions.buy({
        target: directListingTarget,
        expected: { currency: 'ETH', price: '1.2' },
        returnPath: '/buy/complete',
      });

      // One 4xx can be edge infrastructure having a moment; the watcher only
      // believes the second consecutive one.
      await vi.advanceTimersByTimeAsync(4000);
      expect(statusRequests).toBe(2);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(statusRequests).toBe(2);
      expect(popup.closed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports expired when the server says the intent expired', async () => {
    // Rare API never writes an `expired` status to the intent — expiry IS the
    // 410. Handing back the old requires_user would read as a flow still in
    // progress; the honest terminal answer is expired. The window stays open:
    // only the hosted page knows whether closing mid-payment is safe.
    vi.useFakeTimers();
    try {
      let statusRequests = 0;
      const settled: ConnectIntent[] = [];
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
        onIntentSettled: (intent) => {
          settled.push(intent);
        },
        popup: { open: () => popup },
        fetch: async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);

          if (request.method === 'GET') {
            statusRequests += 1;
            if (statusRequests === 1) {
              return jsonResponse({
                data: {
                  intentId: 'connect_intent_buy',
                  type: 'buy',
                  status: 'requires_user',
                  returnPath: '/buy/complete',
                  expiresAt: futureExpiry(),
                },
              });
            }
            return jsonResponse({ error: 'Connect intent expired' }, { status: 410 });
          }

          return connectIntentCreationResponse('connect_intent_buy');
        },
        sessionStorage: false,
      });

      await client.actions.buy({
        target: directListingTarget,
        expected: { currency: 'ETH', price: '1.2' },
        returnPath: '/buy/complete',
      });

      await vi.advanceTimersByTimeAsync(6000);

      // One 410 is definitive: rare-api only answers it for expiry, so the
      // watcher does not spend a confirmation tick on it.
      expect(statusRequests).toBe(2);
      expect(popup.closed).toBe(false);
      expect(settled).toHaveLength(1);
      expect(settled[0]?.status).toBe('expired');
      expect(settled[0]?.intentId).toBe('connect_intent_buy');
    } finally {
      vi.useRealTimers();
    }
  });

  it('breaks the gone streak when a retryable failure interrupts it', async () => {
    // 404 → 503 → 404 is not "two consecutive" gone answers: the 503 says the
    // server is having a moment, so the count starts over — and a healthy
    // answer afterwards proves the watcher was right to keep going.
    vi.useFakeTimers();
    try {
      let statusRequests = 0;
      const settled: ConnectIntent[] = [];
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
        onIntentSettled: (intent) => {
          settled.push(intent);
        },
        popup: { open: () => popup },
        fetch: async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);

          if (request.method === 'GET') {
            statusRequests += 1;
            if (statusRequests === 1 || statusRequests === 3) {
              return jsonResponse({ error: 'not found' }, { status: 404 });
            }
            if (statusRequests === 2) {
              return jsonResponse({ error: 'unavailable' }, { status: 503 });
            }
            return jsonResponse({
              data: {
                intentId: 'connect_intent_buy',
                type: 'buy',
                status: 'completed',
                returnPath: '/buy/complete',
                expiresAt: futureExpiry(),
              },
            });
          }

          return connectIntentCreationResponse('connect_intent_buy');
        },
        sessionStorage: false,
      });

      await client.actions.buy({
        target: directListingTarget,
        expected: { currency: 'ETH', price: '1.2' },
        returnPath: '/buy/complete',
      });

      await vi.advanceTimersByTimeAsync(10_000);

      expect(statusRequests).toBe(4);
      expect(settled).toHaveLength(1);
      expect(settled[0]?.status).toBe('completed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not replay a stale snapshot when the close-tick reread says gone', async () => {
    // processing seen, then the buyer closes on a tick that 410s, and the
    // bounded reread 410s too: reporting the old `processing` would tell the
    // integrator a disowned intent is still in flight. The 410 is the expiry
    // and is reported as such.
    vi.useFakeTimers();
    try {
      let statusRequests = 0;
      const settled: ConnectIntent[] = [];
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
        onIntentSettled: (intent) => {
          settled.push(intent);
        },
        popup: { open: () => popup },
        fetch: async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);

          if (request.method === 'GET') {
            statusRequests += 1;
            if (statusRequests === 1) {
              return jsonResponse({
                data: {
                  intentId: 'connect_intent_buy',
                  type: 'buy',
                  status: 'processing',
                  returnPath: '/buy/complete',
                  expiresAt: futureExpiry(),
                },
              });
            }
            popup.closed = true;
            return jsonResponse({ error: 'Connect intent expired' }, { status: 410 });
          }

          return connectIntentCreationResponse('connect_intent_buy');
        },
        sessionStorage: false,
      });

      await client.actions.buy({
        target: directListingTarget,
        expected: { currency: 'ETH', price: '1.2' },
        returnPath: '/buy/complete',
      });

      await vi.advanceTimersByTimeAsync(6000);

      expect(settled).toHaveLength(1);
      expect(settled[0]?.status).toBe('expired');
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-reads before reporting an early close whose last poll failed', async () => {
    // People close the window right when the status changes. If the tick that
    // saw the close also failed, the known state is 2s old — a success would
    // be reported as `processing`. The close branch re-reads first.
    vi.useFakeTimers();
    try {
      let statusRequests = 0;
      const settled: ConnectIntent[] = [];
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
        onIntentSettled: (intent) => {
          settled.push(intent);
        },
        popup: { open: () => popup },
        fetch: async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);

          if (request.method === 'GET') {
            statusRequests += 1;
            if (statusRequests === 1) {
              return jsonResponse({
                data: {
                  intentId: 'connect_intent_buy',
                  type: 'buy',
                  status: 'processing',
                  returnPath: '/buy/complete',
                  expiresAt: futureExpiry(),
                },
              });
            }
            if (statusRequests === 2) {
              // The buyer closes on the tick whose poll also fails: the known
              // state is now one interval old.
              popup.closed = true;
              return jsonResponse({ error: 'flaky edge' }, { status: 503 });
            }
            return jsonResponse({
              data: {
                intentId: 'connect_intent_buy',
                type: 'buy',
                status: 'completed',
                returnPath: '/buy/complete',
                expiresAt: futureExpiry(),
              },
            });
          }

          return connectIntentCreationResponse('connect_intent_buy');
        },
        sessionStorage: false,
      });

      await client.actions.buy({
        target: directListingTarget,
        expected: { currency: 'ETH', price: '1.2' },
        returnPath: '/buy/complete',
      });

      await vi.advanceTimersByTimeAsync(6000);

      expect(statusRequests).toBe(3);
      expect(settled).toHaveLength(1);
      expect(settled[0]?.status).toBe('completed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives each concurrent action popup its own window', async () => {
    // Fake timers + terminal poll responses: both watchers settle inside the
    // test instead of polling in the background until their fallback deadline.
    vi.useFakeTimers();
    try {
      const openedTargets: string[] = [];
      const client = createSuperRareClient({
        apiUrl: 'https://rare-api.test',
        createState: () => 'state_popup',
        popup: {
          open: (_url, target) => {
            openedTargets.push(target);
            return {
              closed: false,
              close: () => undefined,
              location: { replace: () => undefined },
            };
          },
        },
        fetch: async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);

          if (request.method === 'GET') {
            return jsonResponse({
              data: {
                intentId: 'connect_intent_buy',
                type: 'buy',
                status: 'completed',
                returnPath: '/buy/complete',
                expiresAt: futureExpiry(),
              },
            });
          }

          return connectIntentCreationResponse('connect_intent_buy');
        },
        sessionStorage: false,
      });

      await client.actions.buy({
        target: directListingTarget,
        expected: { currency: 'ETH', price: '1.2' },
        returnPath: '/buy/complete',
      });
      await client.actions.buy({
        target: directListingTarget,
        expected: { currency: 'ETH', price: '1.2' },
        returnPath: '/buy/complete',
      });

      expect(openedTargets).toHaveLength(2);
      // Two buys must not share a browsing context: the first watcher would
      // otherwise close the window the second is being paid in.
      expect(new Set(openedTargets).size).toBe(2);

      await vi.advanceTimersByTimeAsync(2000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws when the window cannot be opened, before creating an intent', async () => {
    // There is no same-page fallback: a blocked window fails the whole action
    // with a typed error, and no intent has been created for it.
    const fetchImplementation = vi.fn(async () => connectIntentCreationResponse('connect_intent_buy'));
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      createState: () => 'state_popup',
      popup: { open: () => null },
      fetch: fetchImplementation,
      sessionStorage: false,
    });

    await expect(client.actions.buy({
      target: directListingTarget,
      expected: { currency: 'ETH', price: '1.2' },
      returnPath: '/buy/complete',
    })).rejects.toBeInstanceOf(ConnectPopupBlockedError);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});

describe('auth.login', () => {
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
      sessionStorage: storage,
    });
    client.auth.onChange((session) => {
      sessionChanges.push(session?.sessionId);
    });

    const resultPromise = client.auth.login({ returnPath: '/auth/callback' });
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
      sessionStorage: createMemoryStorage(),
    });

    const resultPromise = client.auth.login();
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
        sessionStorage: storage,
      });

      const resultPromise = client.auth.login();
      await vi.waitFor(() => {
        expect(popup.replacedUrls).toHaveLength(1);
      });
      popup.closed = true;
      await vi.advanceTimersByTimeAsync(2000);

      await expect(resultPromise).resolves.toEqual({ status: 'cancelled' });
      expect(emitter.listenerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves expired once the login intent deadline passes with no callback', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
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
            // Four seconds out, so the watcher's 2s poll passes it.
            expiresAt: '2026-06-01T00:00:04.000Z',
          },
        }),
        sessionStorage: createMemoryStorage(),
      });

      const resultPromise = client.auth.login();
      await vi.waitFor(() => {
        expect(popup.replacedUrls).toHaveLength(1);
      });
      // No callback ever arrives; the deadline passes and the watcher closes.
      await vi.advanceTimersByTimeAsync(6000);

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
      sessionStorage: createMemoryStorage(),
    });

    const resultPromise = client.auth.login();
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

  it('throws when the window cannot be opened, before creating an intent', async () => {
    // There is no same-page fallback: a blocked window fails the login with a
    // typed error, and no intent has been created yet.
    const emitter = createMessageEmitter();
    const fetchImplementation = vi.fn(async () => loginIntentCreationResponse());
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      createState: () => 'state_login',
      popup: { open: () => null, messageEvents: emitter.messageEvents },
      fetch: fetchImplementation,
      sessionStorage: createMemoryStorage(),
    });

    await expect(client.auth.login()).rejects.toBeInstanceOf(ConnectPopupBlockedError);
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(emitter.listenerCount()).toBe(0);
  });

  it('refuses to start without a message-event source', async () => {
    // Without one the hosted page's callback could never be received, so the
    // login could never complete. Node has no window message events and this
    // client supplies none.
    const fetchImplementation = vi.fn(async () => loginIntentCreationResponse());
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      createState: () => 'state_login',
      popup: { open: () => createPopupStub() },
      fetch: fetchImplementation,
      sessionStorage: createMemoryStorage(),
    });

    await expect(client.auth.login()).rejects.toThrow('no message-event source');
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('surfaces an exchange failure as a rejection', async () => {
    const popup = createPopupStub();
    const emitter = createMessageEmitter();
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      createState: () => 'state_login',
      popup: { open: () => popup, messageEvents: emitter.messageEvents },
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (request.url.endsWith('/v1/connect/auth/exchange')) {
          return jsonResponse({ error: 'invalid connect auth exchange' }, { status: 401 });
        }
        return loginIntentCreationResponse();
      },
      sessionStorage: createMemoryStorage(),
    });

    const resultPromise = client.auth.login();
    await vi.waitFor(() => {
      expect(popup.replacedUrls).toHaveLength(1);
    });
    emitter.emit({ origin: 'https://connect.superrare.test', data: authCallbackMessage });

    await expect(resultPromise).rejects.toMatchObject({
      name: 'SuperRareConnectApiError',
      status: 401,
      path: '/v1/connect/auth/exchange',
    } satisfies Partial<SuperRareConnectApiError>);
    expect(client.auth.getSession()).toBeUndefined();
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
      sessionStorage: false,
    });

    const resultPromise = client.auth.login();
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
      sessionStorage: createMemoryStorage(),
    });

    const firstPromise = client.auth.login();
    // The deprecated alias is the same call, so it joins rather than racing.
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
        sessionStorage: createMemoryStorage(),
      });

      const closePopupAt = (index: number): void => {
        const openedPopup = popups[index];
        if (openedPopup === undefined) {
          throw new Error(`expected a popup at index ${index}`);
        }
        openedPopup.closed = true;
      };

      const firstPromise = client.auth.login();
      await vi.waitFor(() => {
        expect(popups).toHaveLength(1);
      });
      closePopupAt(0);
      await vi.advanceTimersByTimeAsync(2000);
      await expect(firstPromise).resolves.toEqual({ status: 'cancelled' });

      // The lock is gone: a later login starts its own window.
      const secondPromise = client.auth.login();
      await vi.waitFor(() => {
        expect(popups).toHaveLength(2);
      });
      closePopupAt(1);
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
        sessionStorage: storage,
      });

      const resultPromise = client.auth.login();
      await vi.advanceTimersByTimeAsync(0);
      // Closed before the login watcher exists — the gap this covers.
      popup.closed = true;
      await vi.advanceTimersByTimeAsync(2000);

      await expect(resultPromise).resolves.toEqual({ status: 'cancelled' });
      expect(popup.replacedUrls).toEqual([]);
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
      sessionStorage: createMemoryStorage(),
    });

    const resultPromise = client.auth.login();
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
        sessionStorage: storage,
      });
      client.auth.onChange((session) => {
        sessionChanges.push(session?.sessionId);
      });

      const resultPromise = client.auth.login();
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
      sessionStorage: storage,
    });
    client.auth.onChange((session) => {
      sessionChanges.push(session?.sessionId);
    });

    const resultPromise = client.auth.login();
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
  });

  it('does not let one client instance suppress another client\'s in-flight exchange', async () => {
    // Two clients with independent session storage are independent sessions; a
    // logout on one must not drop a login committing on the other.
    let releaseExchangeB: (() => void) | undefined;
    const emitterB = createMessageEmitter();
    const popupB = createPopupStub();
    const buildClient = (
      key: string,
      storage: ConnectSessionStorage,
      hangExchange: boolean,
    ): ReturnType<typeof createSuperRareClient> =>
      createSuperRareClient({
        apiUrl: 'https://rare-api.test',
        createState: () => 'state_login',
        popup: { open: () => popupB, messageEvents: emitterB.messageEvents },
        fetch: async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);
          if (request.url.endsWith('/v1/connect/auth/exchange')) {
            if (hangExchange) {
              await new Promise<void>((resolve) => {
                releaseExchangeB = resolve;
              });
            }
            return sessionResponse();
          }
          if (request.url.endsWith('/v1/connect/users/me')) return jsonResponse({ error: 'nope' }, { status: 500 });
          return loginIntentCreationResponse();
        },
        sessionStorageKey: key,
        sessionStorage: storage,
      });

    const clientA = buildClient('sr.a', createMemoryStorage(), false);
    const clientB = buildClient('sr.b', createMemoryStorage(), true);

    // B's login has its callback and the exchange is in flight, hung.
    const bPromise = clientB.auth.login();
    await vi.waitFor(() => {
      expect(popupB.replacedUrls).toHaveLength(1);
    });
    emitterB.emit({ origin: 'https://connect.superrare.test', data: authCallbackMessage });
    await vi.waitFor(() => {
      expect(releaseExchangeB).toBeDefined();
    });

    // A clears its own session — moving A's generation, not B's.
    clientA.auth.logout();

    // B's exchange finally resolves: it must still commit B's session.
    releaseExchangeB?.();
    await expect(bPromise).resolves.toMatchObject({
      status: 'authenticated',
      session: { sessionId: 'connect_session_login' },
    });
    expect(clientB.auth.getSession()?.sessionId).toBe('connect_session_login');
  });

  it('delivers and unsubscribes through the default browser message adapter', async () => {
    // Every other popup test injects a fake messageEvents; this one exercises
    // the real globalThis.addEventListener/removeEventListener adapter.
    const listeners = new Map<string, (event: unknown) => void>();
    const addEventListener = vi.fn((type: string, handler: (event: unknown) => void) => {
      listeners.set(type, handler);
    });
    const removeEventListener = vi.fn((type: string) => {
      listeners.delete(type);
    });
    vi.stubGlobal('addEventListener', addEventListener);
    vi.stubGlobal('removeEventListener', removeEventListener);
    try {
      const popup = createPopupStub();
      const client = createSuperRareClient({
        apiUrl: 'https://rare-api.test',
        createState: () => 'state_login',
        // No messageEvents override → the default browser adapter is used.
        popup: { open: () => popup },
        fetch: async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);
          if (request.url.endsWith('/v1/connect/auth/exchange')) return sessionResponse();
          if (request.url.endsWith('/v1/connect/users/me')) return jsonResponse({ error: 'nope' }, { status: 500 });
          return loginIntentCreationResponse();
        },
        sessionStorage: createMemoryStorage(),
      });

      const resultPromise = client.auth.login();
      await vi.waitFor(() => {
        expect(listeners.has('message')).toBe(true);
      });

      // Deliver a message the way the browser would, through the adapter.
      listeners.get('message')?.({
        origin: 'https://connect.superrare.test',
        data: authCallbackMessage,
      });

      await expect(resultPromise).resolves.toMatchObject({ status: 'authenticated' });
      // The adapter unsubscribed its own listener on settle.
      expect(removeEventListener).toHaveBeenCalledWith('message', expect.any(Function));
      expect(listeners.has('message')).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not time out a committed login when the profile lookup is slow', async () => {
    // The central invariant of the redesign: once the session is committed the
    // completion deadline stops applying, so a slow (not failed) /users/me
    // cannot turn a succeeded login into a timeout rejection.
    vi.useFakeTimers();
    try {
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
        sessionStorage: createMemoryStorage(),
      });

      const resultPromise = client.auth.login();
      let settledStatus: string | undefined;
      void resultPromise.then((result) => {
        settledStatus = result.status;
      });

      await vi.advanceTimersByTimeAsync(1);
      emitter.emit({ origin: 'https://connect.superrare.test', data: authCallbackMessage });
      // Let the exchange resolve and commit; the profile lookup then hangs.
      await vi.waitFor(() => {
        expect(releaseProfile).toBeDefined();
      });
      // The session is committed even though the promise has not resolved yet.
      expect(client.auth.getSession()?.sessionId).toBe('connect_session_login');

      // Well past the 20s completion deadline — a committed login must NOT be
      // timed out. If the `!committed` guard regressed, this would reject.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(settledStatus).toBeUndefined();

      releaseProfile?.();
      await expect(resultPromise).resolves.toMatchObject({
        status: 'authenticated',
        user: { username: 'collector' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles even if closing the popup throws while finishing the login', async () => {
    // An integrator-supplied window whose close() throws must not leave the
    // login promise pending forever (which would also wedge the serialization
    // lock).
    const emitter = createMessageEmitter();
    const popup: ConnectPopupWindow = {
      closed: false,
      close(): void {
        throw new Error('window already gone');
      },
      location: {
        replace(): void {},
      },
    };
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
      sessionStorage: createMemoryStorage(),
    });

    const resultPromise = client.auth.login();
    await vi.waitFor(() => {
      expect(emitter.listenerCount()).toBe(1);
    });
    emitter.emit({ origin: 'https://connect.superrare.test', data: authCallbackMessage });

    await expect(resultPromise).resolves.toMatchObject({ status: 'authenticated' });
  });

  it('exchanges an in-hand callback even when the intent expiry is behind the client clock', async () => {
    // Client clock ahead of the server: the intent's expiresAt is already in
    // the past locally, but a callback in hand must still be exchanged — the
    // server, not the client clock, decides expiry. (Regression: the handler
    // used to discard the callback as `expired`.)
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
        if (request.url.endsWith('/v1/connect/users/me')) return jsonResponse({ error: 'nope' }, { status: 500 });
        return jsonResponse({
          data: {
            intentId: 'connect_intent_login',
            url: 'https://connect.superrare.test/login?intentId=connect_intent_login',
            expiresAt: '2020-01-01T00:00:00.000Z',
          },
        });
      },
      sessionStorage: createMemoryStorage(),
    });

    const resultPromise = client.auth.login();
    await vi.waitFor(() => {
      expect(popup.replacedUrls).toHaveLength(1);
    });
    emitter.emit({ origin: 'https://connect.superrare.test', data: authCallbackMessage });

    await expect(resultPromise).resolves.toMatchObject({ status: 'authenticated' });
    expect(exchangeRequests).toHaveLength(1);
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
        sessionStorage: createMemoryStorage(),
      });

      const resultPromise = client.auth.login();
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
      sessionStorage: createMemoryStorage(),
    });

    const resultPromise = client.auth.login();
    await vi.waitFor(() => {
      expect(popup.replacedUrls).toHaveLength(1);
    });
    client.auth.logout();
    emitter.emit({ origin: 'https://connect.superrare.test', data: authCallbackMessage });

    await expect(resultPromise).resolves.toEqual({ status: 'cancelled' });
    expect(client.auth.getSession()).toBeUndefined();
  });

  it('keeps the login authenticated when logout happens during the profile lookup', async () => {
    // Once the session is committed the login has succeeded; a logout during
    // the best-effort profile lookup is a later event (login, then logout),
    // not a reason to report the login as failed.
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
      sessionStorage: createMemoryStorage(),
    });

    const resultPromise = client.auth.login();
    await vi.waitFor(() => {
      expect(popup.replacedUrls).toHaveLength(1);
    });
    emitter.emit({ origin: 'https://connect.superrare.test', data: authCallbackMessage });
    await vi.waitFor(() => {
      expect(releaseProfile).toBeDefined();
    });

    // The session was committed before the profile lookup; logout now.
    client.auth.logout();
    releaseProfile?.();

    await expect(resultPromise).resolves.toMatchObject({ status: 'authenticated' });
    // The login succeeded, but the later logout cleared the session.
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
        sessionStorage: createMemoryStorage(),
      });

    // Serialization is per client, so two clients on one page can still have
    // a login each — they must not share a window name.
    const firstPromise = buildClient().auth.login();
    const secondPromise = buildClient().auth.login();
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
      sessionStorage: storage,
    });

    await expect(client.auth.login()).rejects.toThrow('Invalid Connect intent URL');
    expect(popup.replacedUrls).toEqual([]);
    expect(popup.closed).toBe(true);
  });

  it('cancels the login when logout lands while the intent is being created', async () => {
    // The generation check runs between the intent round trip and the watch:
    // a logout during creation must close the window, not proceed to a login
    // the user already walked away from.
    const emitter = createMessageEmitter();
    const popup = createPopupStub();
    let releaseIntent: (() => void) | undefined;
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      createState: () => 'state_login',
      popup: { open: () => popup, messageEvents: emitter.messageEvents },
      fetch: async () => {
        await new Promise<void>((resolve) => {
          releaseIntent = resolve;
        });
        return loginIntentCreationResponse();
      },
      sessionStorage: createMemoryStorage(),
    });

    const resultPromise = client.auth.login();
    await vi.waitFor(() => {
      expect(releaseIntent).toBeDefined();
    });
    client.auth.logout();
    releaseIntent?.();

    await expect(resultPromise).resolves.toEqual({ status: 'cancelled' });
    expect(popup.replacedUrls).toEqual([]);
    expect(popup.closed).toBe(true);
  });

  it('releases the popup when popup navigation throws', async () => {
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
      sessionStorage: storage,
    });

    await expect(client.auth.login()).rejects.toThrow('navigation blocked');
    expect(popup.closed).toBe(true);
    expect(emitter.listenerCount()).toBe(0);
  });

  it('releases the popup when the intent URL is malformed', async () => {
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
      sessionStorage: storage,
    });

    await expect(client.auth.login()).rejects.toThrow('Invalid Connect intent URL');
    expect(popup.closed).toBe(true);
    expect(popup.replacedUrls).toEqual([]);
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
