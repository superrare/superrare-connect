import { describe, expect, it, vi } from 'vitest';
import {
  ConnectLaunchFailedError,
  ConnectPopupBlockedError,
  ConnectPopupClosedError,
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

const connectOrigin = 'https://connect.superrare.test';

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

type OpenedWindow = {
  url: string;
  target: string;
  features: string;
  popup: ReturnType<typeof createPopupStub>;
};

function createPopupOpenRecorder(): {
  open: (url: string, target: string, features: string) => ConnectPopupWindow;
  opened: OpenedWindow[];
} {
  const opened: OpenedWindow[] = [];

  return {
    open(url, target, features) {
      const popup = createPopupStub();
      opened.push({ url, target, features, popup });
      return popup;
    },
    opened,
  };
}

// The request and launch id travel to the hosted page in the URL fragment;
// tests recover them from the opened URL both to assert the request shape
// and to speak as the launch page would.
function readLaunchFromUrl(url: string): {
  launchId: string;
  origin: string;
  request: Record<string, unknown>;
} {
  const parsedUrl = new URL(url);
  expect(parsedUrl.pathname).toBe('/launch');
  const payload: unknown = JSON.parse(decodeURIComponent(parsedUrl.hash.slice(1)));
  if (
    typeof payload !== 'object' || payload === null ||
    !('launchId' in payload) || typeof payload.launchId !== 'string' ||
    !('request' in payload) || typeof payload.request !== 'object' || payload.request === null
  ) {
    throw new Error('unreachable: opened URL carries no launch payload');
  }

  return {
    launchId: payload.launchId,
    origin: parsedUrl.origin,
    request: payload.request as Record<string, unknown>,
  };
}

function launchCreatedMessage(
  openedUrl: string,
  intent: Partial<{ intentId: string; url: string; expiresAt: string }> = {},
): EmittedMessage {
  const launch = readLaunchFromUrl(openedUrl);

  return {
    origin: launch.origin,
    data: {
      type: 'superrare-connect:launch-created',
      launchId: launch.launchId,
      intentId: intent.intentId ?? 'connect_intent_login',
      url: intent.url ?? `${launch.origin}/login?intentId=${intent.intentId ?? 'connect_intent_login'}`,
      expiresAt: intent.expiresAt ?? futureExpiry(),
    },
  };
}

// Emits the launch report, then drains microtasks until the next watcher
// (the login's auth-callback listener) has subscribed — otherwise a message
// emitted right after this one is lost in the handover gap. Microtask
// draining works under both real and fake timers.
async function completeLaunch(
  emitter: ReturnType<typeof createMessageEmitter>,
  openedUrl: string,
  intent: Partial<{ intentId: string; url: string; expiresAt: string }> = {},
): Promise<void> {
  emitter.emit(launchCreatedMessage(openedUrl, intent));
  for (let drains = 0; drains < 50 && emitter.listenerCount() === 0; drains += 1) {
    await Promise.resolve();
  }
  expect(emitter.listenerCount()).toBe(1);
}

function launchFailedMessage(openedUrl: string, message: string): EmittedMessage {
  const launch = readLaunchFromUrl(openedUrl);

  return {
    origin: launch.origin,
    data: {
      type: 'superrare-connect:launch-failed',
      launchId: launch.launchId,
      message,
    },
  };
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

// The standard login-capable client: launch handoff through the recorder and
// emitter, exchange/profile through the fetch mock, watcher polls terminal.
function createLoginTestClient(overrides: {
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  sessionStorage?: ConnectSessionStorage | false;
  connectUrl?: string;
} = {}): {
  client: ReturnType<typeof createSuperRareClient>;
  emitter: ReturnType<typeof createMessageEmitter>;
  opened: OpenedWindow[];
} {
  const emitter = createMessageEmitter();
  const recorder = createPopupOpenRecorder();
  const client = createSuperRareClient({
    apiUrl: 'https://rare-api.test',
    connectUrl: overrides.connectUrl ?? connectOrigin,
    createState: () => 'state_login',
    popup: { open: recorder.open, messageEvents: emitter.messageEvents },
    fetch: overrides.fetch ?? (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url.endsWith('/v1/connect/auth/exchange')) return sessionResponse();
      if (request.url.endsWith('/v1/connect/users/me')) return jsonResponse({ error: 'nope' }, { status: 500 });
      return completedIntentStatusResponse(request);
    }),
    sessionStorage: overrides.sessionStorage ?? createMemoryStorage(),
  });

  return { client, emitter, opened: recorder.opened };
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
    const { client, emitter, opened } = createLoginTestClient();

    const unsubscribe = client.auth.onChange(listener);

    const completeLogin = async (): Promise<void> => {
      const resultPromise = client.auth.login();
      const openedWindow = opened[opened.length - 1];
      if (openedWindow === undefined) throw new Error('expected a window');
      await completeLaunch(emitter, openedWindow.url);
      emitter.emit({ origin: connectOrigin, data: authCallbackMessage });
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

  it('opens each hosted action at the launch page with the request in the fragment', async () => {
    vi.useFakeTimers();
    try {
      const emitter = createMessageEmitter();
      const recorder = createPopupOpenRecorder();
      const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const request = input instanceof Request ? input : new Request(input, init);
        expect(request.method).toBe('GET');
        expect(request.headers.get('authorization')).toBeNull();
        return completedIntentStatusResponse(request);
      });
      const client = createSuperRareClient({
        apiUrl: 'https://rare-api.test',
        connectUrl: connectOrigin,
        createState: () => 'state_action',
        initiatingOrigin: 'https://artist.example',
        popup: { open: recorder.open, messageEvents: emitter.messageEvents },
        fetch: fetchImplementation,
        sessionStorage: false,
      });

      const runAction = async (
        start: () => Promise<{ intentId: string }>,
        intentId: string,
      ): Promise<Record<string, unknown>> => {
        const intentPromise = start();
        const openedWindow = recorder.opened[recorder.opened.length - 1];
        if (openedWindow === undefined) throw new Error('expected a window');
        expect(openedWindow.target).toMatch(/^superrare-connect-intent-.+/);
        const launch = readLaunchFromUrl(openedWindow.url);
        expect(launch.origin).toBe(connectOrigin);
        emitter.emit(launchCreatedMessage(openedWindow.url, {
          intentId,
          url: `${connectOrigin}/intents/${intentId}`,
        }));
        await expect(intentPromise).resolves.toMatchObject({ intentId });
        return launch.request;
      };

      // The request each hosted flow was opened with IS the create-intent
      // request — the launch page forwards it verbatim.
      expect(await runAction(
        () => client.checkout.start({ target: checkoutTarget, returnPath: '/thanks' }),
        'connect_intent_checkout',
      )).toEqual({
        action: { type: 'checkout', target: checkoutTarget },
        returnPath: '/thanks',
        state: 'state_action',
        initiatingOrigin: 'https://artist.example',
      });

      expect(await runAction(
        () => client.actions.buy({
          target: directListingTarget,
          expected: { currency: 'ETH', price: '1.2' },
          payment: { method: 'wallet' },
          returnPath: '/buy/complete',
        }),
        'connect_intent_buy',
      )).toEqual({
        action: {
          type: 'buy',
          target: directListingTarget,
          expected: { currency: 'ETH', price: '1.2' },
        },
        payment: { method: 'wallet' },
        returnPath: '/buy/complete',
        state: 'state_action',
        initiatingOrigin: 'https://artist.example',
      });

      expect(await runAction(
        () => client.actions.bid({
          target: reserveAuctionTarget,
          bid: { currency: 'ETH', amount: '1.2' },
          returnPath: '/bid/complete',
        }),
        'connect_intent_bid',
      )).toMatchObject({
        action: { type: 'bid', target: reserveAuctionTarget, bid: { currency: 'ETH', amount: '1.2' } },
      });

      expect(await runAction(
        () => client.actions.mint({
          target: releaseTarget,
          purchase: { quantity: '2', currency: 'ETH', unitPrice: '0.5' },
          returnPath: '/mint/complete',
        }),
        'connect_intent_mint',
      )).toMatchObject({
        action: { type: 'mint', target: releaseTarget, purchase: { quantity: '2', currency: 'ETH', unitPrice: '0.5' } },
      });

      expect(await runAction(
        () => client.actions.settle({ target: reserveAuctionTarget, returnPath: '/settle/complete' }),
        'connect_intent_settle',
      )).toMatchObject({
        action: { type: 'settle', target: reserveAuctionTarget },
      });

      expect(await runAction(
        () => client.offers.make({
          target: offerTarget,
          offer: { currency: 'ETH', amount: '1.2' },
          returnPath: '/offer/complete',
        }),
        'connect_intent_offer',
      )).toMatchObject({
        action: { type: 'offer', target: offerTarget, offer: { currency: 'ETH', amount: '1.2' } },
      });

      expect(await runAction(
        () => client.offers.accept({
          target: offerTarget,
          expected: { currency: 'ETH', amount: '1.2' },
          returnPath: '/offer/accept/complete',
        }),
        'connect_intent_offer_accept',
      )).toMatchObject({
        action: { type: 'offer-accept', target: offerTarget, expected: { currency: 'ETH', amount: '1.2' } },
      });

      expect(await runAction(
        () => client.offers.cancel({ target: batchOfferTarget, returnPath: '/offer/cancel/complete' }),
        'connect_intent_offer_cancel',
      )).toMatchObject({
        action: { type: 'offer-cancel', target: batchOfferTarget },
      });

      // Creation never touched the network from this page: every fetch the
      // client made was a watcher status poll.
      await vi.advanceTimersByTimeAsync(2000);
      expect(fetchImplementation.mock.calls.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rewrites the reported hosted URL onto the configured connect origin', async () => {
    vi.useFakeTimers();
    try {
      const emitter = createMessageEmitter();
      const recorder = createPopupOpenRecorder();
      const client = createSuperRareClient({
        apiUrl: 'https://rare-api.test',
        connectUrl: connectOrigin,
        createState: () => 'state_buy',
        popup: { open: recorder.open, messageEvents: emitter.messageEvents },
        fetch: async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);
          return completedIntentStatusResponse(request);
        },
        sessionStorage: false,
      });

      const intentPromise = client.actions.buy({
        target: directListingTarget,
        expected: { currency: 'ETH', price: '1.2' },
        returnPath: '/buy/complete',
      });
      const openedWindow = recorder.opened[0];
      if (openedWindow === undefined) throw new Error('expected a window');
      // A dev Rare API reports its own idea of the hosted origin; the URL
      // handed to the integrator gets the configured connect origin instead.
      emitter.emit(launchCreatedMessage(openedWindow.url, {
        intentId: 'connect_intent_buy',
        url: 'https://0.0.0.0:3000/action/connect_intent_buy',
      }));

      await expect(intentPromise).resolves.toMatchObject({
        intentId: 'connect_intent_buy',
        url: `${connectOrigin}/action/connect_intent_buy`,
      });

      await vi.advanceTimersByTimeAsync(2000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens hosted intents in a sized window and closes it once the intent settles', async () => {
    vi.useFakeTimers();
    try {
      const emitter = createMessageEmitter();
      const recorder = createPopupOpenRecorder();
      const settledStatuses: string[] = [];
      let statusRequests = 0;
      const client = createSuperRareClient({
        apiUrl: 'https://rare-api.test',
        connectUrl: connectOrigin,
        createState: () => 'state_popup',
        popup: {
          width: 400,
          height: 640,
          open: recorder.open,
          messageEvents: emitter.messageEvents,
        },
        onIntentSettled: (intent) => {
          settledStatuses.push(intent.status);
        },
        fetch: async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);
          statusRequests += 1;
          return jsonResponse({
            data: {
              intentId: 'connect_intent_buy',
              type: 'buy',
              status: statusRequests < 2 ? 'requires_user' : 'completed',
              returnPath: '/buy/complete',
              expiresAt: futureExpiry(),
            },
          });
        },
        sessionStorage: false,
      });

      const intentPromise = client.actions.buy({
        target: directListingTarget,
        expected: { currency: 'ETH', price: '1.2' },
        returnPath: '/buy/complete',
      });
      const openedWindow = recorder.opened[0];
      if (openedWindow === undefined) throw new Error('expected a window');
      expect(openedWindow.features).toContain('popup=yes');
      expect(openedWindow.features).toContain('width=400');
      expect(openedWindow.features).toContain('height=640');
      emitter.emit(launchCreatedMessage(openedWindow.url, {
        intentId: 'connect_intent_buy',
        url: `${connectOrigin}/intents/connect_intent_buy`,
      }));
      await expect(intentPromise).resolves.toMatchObject({ intentId: 'connect_intent_buy' });

      await vi.advanceTimersByTimeAsync(2000);
      expect(openedWindow.popup.closed).toBe(false);
      expect(settledStatuses).toEqual([]);

      await vi.advanceTimersByTimeAsync(2000);
      expect(openedWindow.popup.closed).toBe(true);
      expect(settledStatuses).toEqual(['completed']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the latest intent state when the user closes the window early', async () => {
    vi.useFakeTimers();
    try {
      const emitter = createMessageEmitter();
      const recorder = createPopupOpenRecorder();
      const settledStatuses: string[] = [];
      const client = createSuperRareClient({
        apiUrl: 'https://rare-api.test',
        connectUrl: connectOrigin,
        createState: () => 'state_popup',
        popup: { open: recorder.open, messageEvents: emitter.messageEvents },
        onIntentSettled: (intent) => {
          settledStatuses.push(intent.status);
        },
        fetch: async () => jsonResponse({
          data: {
            intentId: 'connect_intent_buy',
            type: 'buy',
            status: 'requires_user',
            returnPath: '/buy/complete',
            expiresAt: futureExpiry(),
          },
        }),
        sessionStorage: false,
      });

      const intentPromise = client.actions.buy({
        target: directListingTarget,
        expected: { currency: 'ETH', price: '1.2' },
        returnPath: '/buy/complete',
      });
      const openedWindow = recorder.opened[0];
      if (openedWindow === undefined) throw new Error('expected a window');
      emitter.emit(launchCreatedMessage(openedWindow.url, { intentId: 'connect_intent_buy' }));
      await intentPromise;

      await vi.advanceTimersByTimeAsync(2000);
      openedWindow.popup.closed = true;
      await vi.advanceTimersByTimeAsync(2000);
      expect(settledStatuses).toEqual(['requires_user']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a reported intent URL that is not a web URL, and closes the window', async () => {
    // The launch page only navigates itself by path, so this URL is the one
    // handed back to the integrator — an executable URL must never be.
    const emitter = createMessageEmitter();
    const recorder = createPopupOpenRecorder();
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      connectUrl: connectOrigin,
      createState: () => 'state_popup',
      popup: { open: recorder.open, messageEvents: emitter.messageEvents },
      fetch: async () => jsonResponse({ error: 'unused' }, { status: 500 }),
      sessionStorage: false,
    });

    const intentPromise = client.actions.buy({
      target: directListingTarget,
      expected: { currency: 'ETH', price: '1.2' },
      returnPath: '/buy/complete',
    });
    const openedWindow = recorder.opened[0];
    if (openedWindow === undefined) throw new Error('expected a window');
    emitter.emit(launchCreatedMessage(openedWindow.url, {
      intentId: 'connect_intent_buy',
      url: 'javascript:alert(1)',
    }));

    await expect(intentPromise).rejects.toThrow('Invalid Connect intent URL');
    expect(openedWindow.popup.closed).toBe(true);
  });

  it('stops watching an action window once the intent can no longer change', async () => {
    // Regression: the watcher used to poll forever. A buyer who walks away with
    // the window open kept the integrator's page hitting Rare API every 2s.
    vi.useFakeTimers();
    try {
      const emitter = createMessageEmitter();
      const recorder = createPopupOpenRecorder();
      let statusRequests = 0;
      let pollsWithoutDeadline = 0;
      const settled: ConnectIntent[] = [];
      const client = createSuperRareClient({
        apiUrl: 'https://rare-api.test',
        connectUrl: connectOrigin,
        createState: () => 'state_popup',
        onIntentSettled: (intent) => {
          settled.push(intent);
        },
        popup: { open: recorder.open, messageEvents: emitter.messageEvents },
        fetch: async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);
          statusRequests += 1;
          // Each poll must carry its own request deadline; one hung fetch
          // otherwise stalls the whole watcher.
          if (!(init?.signal instanceof AbortSignal)) pollsWithoutDeadline += 1;
          void request;
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
        },
        sessionStorage: false,
      });

      const intentPromise = client.actions.buy({
        target: directListingTarget,
        expected: { currency: 'ETH', price: '1.2' },
        returnPath: '/buy/complete',
      });
      const openedWindow = recorder.opened[0];
      if (openedWindow === undefined) throw new Error('expected a window');
      emitter.emit(launchCreatedMessage(openedWindow.url, {
        intentId: 'connect_intent_buy',
        expiresAt: '2020-01-01T00:00:00.000Z',
      }));
      await intentPromise;

      // A past expiry falls back to a bounded window, so the watcher runs —
      // but it does not run forever.
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      const requestsAfterDeadline = statusRequests;
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(statusRequests).toBe(requestsAfterDeadline);
      // Only a KNOWN terminal outcome closes the buyer's window; a fallback
      // stop leaves it to the hosted page, which may be mid-payment.
      expect(openedWindow.popup.closed).toBe(false);
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
      const emitter = createMessageEmitter();
      const recorder = createPopupOpenRecorder();
      let statusRequests = 0;
      const client = createSuperRareClient({
        apiUrl: 'https://rare-api.test',
        connectUrl: connectOrigin,
        createState: () => 'state_popup',
        popup: { open: recorder.open, messageEvents: emitter.messageEvents },
        fetch: async () => {
          statusRequests += 1;
          // Gone for good: retrying cannot make it readable.
          return jsonResponse({ error: 'Connect intent not found' }, { status: 404 });
        },
        sessionStorage: false,
      });

      const intentPromise = client.actions.buy({
        target: directListingTarget,
        expected: { currency: 'ETH', price: '1.2' },
        returnPath: '/buy/complete',
      });
      const openedWindow = recorder.opened[0];
      if (openedWindow === undefined) throw new Error('expected a window');
      emitter.emit(launchCreatedMessage(openedWindow.url, { intentId: 'connect_intent_buy' }));
      await intentPromise;

      // One 4xx can be edge infrastructure having a moment; the watcher only
      // believes the second consecutive one.
      await vi.advanceTimersByTimeAsync(4000);
      expect(statusRequests).toBe(2);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(statusRequests).toBe(2);
      expect(openedWindow.popup.closed).toBe(false);
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
      const emitter = createMessageEmitter();
      const recorder = createPopupOpenRecorder();
      let statusRequests = 0;
      const settled: ConnectIntent[] = [];
      const client = createSuperRareClient({
        apiUrl: 'https://rare-api.test',
        connectUrl: connectOrigin,
        createState: () => 'state_popup',
        onIntentSettled: (intent) => {
          settled.push(intent);
        },
        popup: { open: recorder.open, messageEvents: emitter.messageEvents },
        fetch: async () => {
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
        },
        sessionStorage: false,
      });

      const intentPromise = client.actions.buy({
        target: directListingTarget,
        expected: { currency: 'ETH', price: '1.2' },
        returnPath: '/buy/complete',
      });
      const openedWindow = recorder.opened[0];
      if (openedWindow === undefined) throw new Error('expected a window');
      emitter.emit(launchCreatedMessage(openedWindow.url, { intentId: 'connect_intent_buy' }));
      await intentPromise;

      await vi.advanceTimersByTimeAsync(6000);

      // One 410 is definitive: rare-api only answers it for expiry, so the
      // watcher does not spend a confirmation tick on it.
      expect(statusRequests).toBe(2);
      expect(openedWindow.popup.closed).toBe(false);
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
      const emitter = createMessageEmitter();
      const recorder = createPopupOpenRecorder();
      let statusRequests = 0;
      const settled: ConnectIntent[] = [];
      const client = createSuperRareClient({
        apiUrl: 'https://rare-api.test',
        connectUrl: connectOrigin,
        createState: () => 'state_popup',
        onIntentSettled: (intent) => {
          settled.push(intent);
        },
        popup: { open: recorder.open, messageEvents: emitter.messageEvents },
        fetch: async () => {
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
        },
        sessionStorage: false,
      });

      const intentPromise = client.actions.buy({
        target: directListingTarget,
        expected: { currency: 'ETH', price: '1.2' },
        returnPath: '/buy/complete',
      });
      const openedWindow = recorder.opened[0];
      if (openedWindow === undefined) throw new Error('expected a window');
      emitter.emit(launchCreatedMessage(openedWindow.url, { intentId: 'connect_intent_buy' }));
      await intentPromise;

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
      const emitter = createMessageEmitter();
      const recorder = createPopupOpenRecorder();
      let statusRequests = 0;
      const settled: ConnectIntent[] = [];
      const client = createSuperRareClient({
        apiUrl: 'https://rare-api.test',
        connectUrl: connectOrigin,
        createState: () => 'state_popup',
        onIntentSettled: (intent) => {
          settled.push(intent);
        },
        popup: { open: recorder.open, messageEvents: emitter.messageEvents },
        fetch: async () => {
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
          const openedWindow = recorder.opened[0];
          if (openedWindow !== undefined) openedWindow.popup.closed = true;
          return jsonResponse({ error: 'Connect intent expired' }, { status: 410 });
        },
        sessionStorage: false,
      });

      const intentPromise = client.actions.buy({
        target: directListingTarget,
        expected: { currency: 'ETH', price: '1.2' },
        returnPath: '/buy/complete',
      });
      const openedWindow = recorder.opened[0];
      if (openedWindow === undefined) throw new Error('expected a window');
      emitter.emit(launchCreatedMessage(openedWindow.url, { intentId: 'connect_intent_buy' }));
      await intentPromise;

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
      const emitter = createMessageEmitter();
      const recorder = createPopupOpenRecorder();
      let statusRequests = 0;
      const settled: ConnectIntent[] = [];
      const client = createSuperRareClient({
        apiUrl: 'https://rare-api.test',
        connectUrl: connectOrigin,
        createState: () => 'state_popup',
        onIntentSettled: (intent) => {
          settled.push(intent);
        },
        popup: { open: recorder.open, messageEvents: emitter.messageEvents },
        fetch: async () => {
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
            const openedWindow = recorder.opened[0];
            if (openedWindow !== undefined) openedWindow.popup.closed = true;
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
        },
        sessionStorage: false,
      });

      const intentPromise = client.actions.buy({
        target: directListingTarget,
        expected: { currency: 'ETH', price: '1.2' },
        returnPath: '/buy/complete',
      });
      const openedWindow = recorder.opened[0];
      if (openedWindow === undefined) throw new Error('expected a window');
      emitter.emit(launchCreatedMessage(openedWindow.url, { intentId: 'connect_intent_buy' }));
      await intentPromise;

      await vi.advanceTimersByTimeAsync(6000);

      expect(statusRequests).toBe(3);
      expect(settled).toHaveLength(1);
      expect(settled[0]?.status).toBe('completed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives each concurrent action window its own name and launch id', async () => {
    vi.useFakeTimers();
    try {
      const emitter = createMessageEmitter();
      const recorder = createPopupOpenRecorder();
      const client = createSuperRareClient({
        apiUrl: 'https://rare-api.test',
        connectUrl: connectOrigin,
        createState: () => 'state_popup',
        popup: { open: recorder.open, messageEvents: emitter.messageEvents },
        fetch: async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);
          return completedIntentStatusResponse(request);
        },
        sessionStorage: false,
      });

      const buy = (): Promise<{ intentId: string }> => client.actions.buy({
        target: directListingTarget,
        expected: { currency: 'ETH', price: '1.2' },
        returnPath: '/buy/complete',
      });

      const firstPromise = buy();
      const secondPromise = buy();
      expect(recorder.opened).toHaveLength(2);
      const [firstWindow, secondWindow] = recorder.opened;
      if (firstWindow === undefined || secondWindow === undefined) throw new Error('expected windows');

      // Two buys must not share a browsing context or a launch id: the first
      // watcher would otherwise close (or claim) the window the second is
      // being paid in.
      expect(firstWindow.target).not.toBe(secondWindow.target);
      expect(readLaunchFromUrl(firstWindow.url).launchId)
        .not.toBe(readLaunchFromUrl(secondWindow.url).launchId);

      // Each report lands on its own flow.
      emitter.emit(launchCreatedMessage(secondWindow.url, { intentId: 'connect_intent_second' }));
      emitter.emit(launchCreatedMessage(firstWindow.url, { intentId: 'connect_intent_first' }));
      await expect(firstPromise).resolves.toMatchObject({ intentId: 'connect_intent_first' });
      await expect(secondPromise).resolves.toMatchObject({ intentId: 'connect_intent_second' });

      await vi.advanceTimersByTimeAsync(2000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores launch reports from a foreign origin', async () => {
    const emitter = createMessageEmitter();
    const recorder = createPopupOpenRecorder();
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      connectUrl: connectOrigin,
      createState: () => 'state_popup',
      popup: { open: recorder.open, messageEvents: emitter.messageEvents },
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        return completedIntentStatusResponse(request);
      },
      sessionStorage: false,
    });

    vi.useFakeTimers();
    try {
      const intentPromise = client.actions.buy({
        target: directListingTarget,
        expected: { currency: 'ETH', price: '1.2' },
        returnPath: '/buy/complete',
      });
      const openedWindow = recorder.opened[0];
      if (openedWindow === undefined) throw new Error('expected a window');

      // A hostile page cannot speak for the connect origin.
      const forged = launchCreatedMessage(openedWindow.url, { intentId: 'connect_intent_evil' });
      emitter.emit({ ...forged, origin: 'https://evil.test' });
      await vi.advanceTimersByTimeAsync(0);

      emitter.emit(launchCreatedMessage(openedWindow.url, { intentId: 'connect_intent_real' }));
      await expect(intentPromise).resolves.toMatchObject({ intentId: 'connect_intent_real' });

      await vi.advanceTimersByTimeAsync(2000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects with the hosted page\'s explanation when the launch fails', async () => {
    const emitter = createMessageEmitter();
    const recorder = createPopupOpenRecorder();
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      connectUrl: connectOrigin,
      createState: () => 'state_popup',
      popup: { open: recorder.open, messageEvents: emitter.messageEvents },
      fetch: async () => jsonResponse({ error: 'unused' }, { status: 500 }),
      sessionStorage: false,
    });

    const intentPromise = client.actions.buy({
      target: directListingTarget,
      expected: { currency: 'ETH', price: '1.2' },
      returnPath: '/buy/complete',
    });
    const openedWindow = recorder.opened[0];
    if (openedWindow === undefined) throw new Error('expected a window');
    emitter.emit(launchFailedMessage(openedWindow.url, 'Unsupported chain for this action.'));

    await expect(intentPromise).rejects.toBeInstanceOf(ConnectLaunchFailedError);
    // The window is showing the same explanation; the SDK leaves it open.
    expect(openedWindow.popup.closed).toBe(false);
  });

  it('rejects when the window is closed before the launch reports', async () => {
    vi.useFakeTimers();
    try {
      const emitter = createMessageEmitter();
      const recorder = createPopupOpenRecorder();
      const client = createSuperRareClient({
        apiUrl: 'https://rare-api.test',
        connectUrl: connectOrigin,
        createState: () => 'state_popup',
        popup: { open: recorder.open, messageEvents: emitter.messageEvents },
        fetch: async () => jsonResponse({ error: 'unused' }, { status: 500 }),
        sessionStorage: false,
      });

      const intentPromise = client.actions.buy({
        target: directListingTarget,
        expected: { currency: 'ETH', price: '1.2' },
        returnPath: '/buy/complete',
      });
      const outcome = intentPromise.catch((error: unknown) => error);
      const openedWindow = recorder.opened[0];
      if (openedWindow === undefined) throw new Error('expected a window');
      openedWindow.popup.closed = true;
      await vi.advanceTimersByTimeAsync(2000);

      await expect(outcome).resolves.toBeInstanceOf(ConnectPopupClosedError);
      expect(emitter.listenerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws when the window cannot be opened, before anything is created', async () => {
    // There is no same-page fallback: a blocked window fails the whole action
    // with a typed error, and nothing has been created for it anywhere.
    const emitter = createMessageEmitter();
    const fetchImplementation = vi.fn(async () => jsonResponse({ error: 'unused' }, { status: 500 }));
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      connectUrl: connectOrigin,
      createState: () => 'state_popup',
      popup: { open: () => null, messageEvents: emitter.messageEvents },
      fetch: fetchImplementation,
      sessionStorage: false,
    });

    await expect(client.actions.buy({
      target: directListingTarget,
      expected: { currency: 'ETH', price: '1.2' },
      returnPath: '/buy/complete',
    })).rejects.toBeInstanceOf(ConnectPopupBlockedError);
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(emitter.listenerCount()).toBe(0);
  });

  it('refuses to start an action without a message-event source', async () => {
    // Without one the launch page's report could never be received. Node has
    // no window message events and this client supplies none.
    const recorder = createPopupOpenRecorder();
    const fetchImplementation = vi.fn(async () => jsonResponse({ error: 'unused' }, { status: 500 }));
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      connectUrl: connectOrigin,
      createState: () => 'state_popup',
      popup: { open: recorder.open },
      fetch: fetchImplementation,
      sessionStorage: false,
    });

    await expect(client.actions.buy({
      target: directListingTarget,
      expected: { currency: 'ETH', price: '1.2' },
      returnPath: '/buy/complete',
    })).rejects.toThrow('no message-event source');
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(recorder.opened).toHaveLength(0);
  });

  it('supports anonymous intent reads without a Connect session', async () => {
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        expect(request.method).toBe('GET');
        expect(request.headers.get('authorization')).toBeNull();
        expect(request.url).toBe('https://rare-api.test/v1/connect/intents/connect_intent_bid');
        return jsonResponse({
          data: {
            intentId: 'connect_intent_bid',
            type: 'bid',
            status: 'pending',
            returnPath: '/bid/complete',
            expiresAt: futureExpiry(),
          },
        });
      },
      sessionStorage: false,
    });

    await expect(client.actions.getStatus({
      intentId: 'connect_intent_bid',
    })).resolves.toMatchObject({ status: 'pending' });
    await expect(client.intents.get({
      intentId: 'connect_intent_bid',
    })).resolves.toMatchObject({ intentId: 'connect_intent_bid' });
  });
});

describe('auth.login', () => {
  it('exchanges the posted callback, stores the session, and resolves with the user', async () => {
    const storage = createMemoryStorage();
    const requestedPaths: string[] = [];
    const sessionChanges: Array<string | undefined> = [];
    const { client, emitter, opened } = createLoginTestClient({
      sessionStorage: storage,
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requestedPaths.push(new URL(request.url).pathname);

        if (request.url.endsWith('/v1/connect/auth/exchange')) {
          expect(await request.json()).toEqual({
            intentId: 'connect_intent_login',
            state: 'state_login',
            code: 'connect_auth_code_login',
          });
          return sessionResponse();
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

        return completedIntentStatusResponse(request);
      },
    });
    client.auth.onChange((session) => {
      sessionChanges.push(session?.sessionId);
    });

    const resultPromise = client.auth.login({ returnPath: '/auth/callback' });
    const openedWindow = opened[0];
    if (openedWindow === undefined) throw new Error('expected a window');
    // The login request rode to the hosted page in the fragment.
    expect(readLaunchFromUrl(openedWindow.url).request).toMatchObject({
      action: { type: 'login' },
      returnPath: '/auth/callback',
      state: 'state_login',
    });
    await completeLaunch(emitter, openedWindow.url);

    // Foreign-origin and unrelated messages are ignored.
    emitter.emit({
      origin: 'https://evil.test',
      data: { ...authCallbackMessage, code: 'stolen' },
    });
    emitter.emit({ origin: connectOrigin, data: { type: 'other' } });

    emitter.emit({ origin: connectOrigin, data: authCallbackMessage });

    const result = await resultPromise;
    expect(result.status).toBe('authenticated');
    if (result.status !== 'authenticated') throw new Error('unreachable');
    expect(result.session.sessionId).toBe('connect_session_login');
    expect(result.session.address).toBe('0x0000000000000000000000000000000000000009');
    expect(result.user?.username).toBe('collector');
    expect(openedWindow.popup.closed).toBe(true);
    expect(emitter.listenerCount()).toBe(0);
    expect(client.auth.getSession()?.sessionId).toBe('connect_session_login');
    expect(sessionChanges).toEqual(['connect_session_login']);
    // Creation never touched the network from this page.
    expect(requestedPaths).toEqual([
      '/v1/connect/auth/exchange',
      '/v1/connect/users/me',
    ]);
  });

  it('still resolves authenticated when the profile lookup fails', async () => {
    const { client, emitter, opened } = createLoginTestClient();

    const resultPromise = client.auth.login();
    const openedWindow = opened[0];
    if (openedWindow === undefined) throw new Error('expected a window');
    await completeLaunch(emitter, openedWindow.url);
    emitter.emit({ origin: connectOrigin, data: authCallbackMessage });

    const result = await resultPromise;
    expect(result).toMatchObject({ status: 'authenticated', user: undefined });
  });

  it('resolves cancelled when the window is closed before completing', async () => {
    vi.useFakeTimers();
    try {
      const { client, emitter, opened } = createLoginTestClient();

      const resultPromise = client.auth.login();
      const openedWindow = opened[0];
      if (openedWindow === undefined) throw new Error('expected a window');
      emitter.emit(launchCreatedMessage(openedWindow.url));
      await vi.advanceTimersByTimeAsync(0);

      openedWindow.popup.closed = true;
      await vi.advanceTimersByTimeAsync(2000);

      await expect(resultPromise).resolves.toEqual({ status: 'cancelled' });
      expect(emitter.listenerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves cancelled when the window is closed before the launch reports', async () => {
    // Closed during creation — the launch page never got to report. For a
    // login that is the person changing their mind, not an error.
    vi.useFakeTimers();
    try {
      const { client, opened } = createLoginTestClient();

      const resultPromise = client.auth.login();
      const openedWindow = opened[0];
      if (openedWindow === undefined) throw new Error('expected a window');
      openedWindow.popup.closed = true;
      await vi.advanceTimersByTimeAsync(2000);

      await expect(resultPromise).resolves.toEqual({ status: 'cancelled' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves expired once the login intent deadline passes with no callback', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
    try {
      const { client, emitter, opened } = createLoginTestClient();

      const resultPromise = client.auth.login();
      const openedWindow = opened[0];
      if (openedWindow === undefined) throw new Error('expected a window');
      emitter.emit(launchCreatedMessage(openedWindow.url, {
        // Four seconds out, so the watcher's 2s poll passes it.
        expiresAt: '2026-06-01T00:00:04.000Z',
      }));
      // No callback ever arrives; the deadline passes and the watcher closes.
      await vi.advanceTimersByTimeAsync(6000);

      await expect(resultPromise).resolves.toEqual({ status: 'expired' });
      expect(openedWindow.popup.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects and closes the window when the callback does not match the pending auth', async () => {
    const { client, emitter, opened } = createLoginTestClient();

    const resultPromise = client.auth.login();
    const openedWindow = opened[0];
    if (openedWindow === undefined) throw new Error('expected a window');
    await completeLaunch(emitter, openedWindow.url);
    emitter.emit({
      origin: connectOrigin,
      data: { ...authCallbackMessage, state: 'state_other' },
    });

    await expect(resultPromise).rejects.toMatchObject({ code: 'state_mismatch' });
    expect(openedWindow.popup.closed).toBe(true);
    expect(emitter.listenerCount()).toBe(0);
  });

  it('throws when the window cannot be opened, before anything is created', async () => {
    const emitter = createMessageEmitter();
    const fetchImplementation = vi.fn(async () => jsonResponse({ error: 'unused' }, { status: 500 }));
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      connectUrl: connectOrigin,
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
    const fetchImplementation = vi.fn(async () => jsonResponse({ error: 'unused' }, { status: 500 }));
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      connectUrl: connectOrigin,
      createState: () => 'state_login',
      popup: { open: () => createPopupStub() },
      fetch: fetchImplementation,
      sessionStorage: createMemoryStorage(),
    });

    await expect(client.auth.login()).rejects.toThrow('no message-event source');
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('rejects with the hosted page\'s explanation when the launch fails', async () => {
    const { client, emitter, opened } = createLoginTestClient();

    const resultPromise = client.auth.login();
    const openedWindow = opened[0];
    if (openedWindow === undefined) throw new Error('expected a window');
    emitter.emit(launchFailedMessage(openedWindow.url, 'Rare API rejected the login.'));

    await expect(resultPromise).rejects.toMatchObject({
      name: 'ConnectLaunchFailedError',
      message: 'Rare API rejected the login.',
    });
  });

  it('surfaces an exchange failure as a rejection', async () => {
    const { client, emitter, opened } = createLoginTestClient({
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (request.url.endsWith('/v1/connect/auth/exchange')) {
          return jsonResponse({ error: 'invalid connect auth exchange' }, { status: 401 });
        }
        return completedIntentStatusResponse(request);
      },
    });

    const resultPromise = client.auth.login();
    const openedWindow = opened[0];
    if (openedWindow === undefined) throw new Error('expected a window');
    await completeLaunch(emitter, openedWindow.url);
    emitter.emit({ origin: connectOrigin, data: authCallbackMessage });

    await expect(resultPromise).rejects.toMatchObject({
      name: 'SuperRareConnectApiError',
      status: 401,
      path: '/v1/connect/auth/exchange',
    } satisfies Partial<SuperRareConnectApiError>);
    expect(client.auth.getSession()).toBeUndefined();
  });

  it('completes with browser storage disabled by verifying the callback against its own pending record', async () => {
    const { client, emitter, opened } = createLoginTestClient({ sessionStorage: false });

    const resultPromise = client.auth.login();
    const openedWindow = opened[0];
    if (openedWindow === undefined) throw new Error('expected a window');
    await completeLaunch(emitter, openedWindow.url);
    emitter.emit({ origin: connectOrigin, data: authCallbackMessage });

    await expect(resultPromise).resolves.toMatchObject({
      status: 'authenticated',
      session: { sessionId: 'connect_session_login' },
    });
  });

  it('joins the login already in flight instead of starting a second one', async () => {
    // The SDK holds a single session, so two concurrent logins could only
    // race for the same slot. A second call joins the first.
    const { client, emitter, opened } = createLoginTestClient();

    const firstPromise = client.auth.login();
    // The deprecated alias is the same call, so it joins rather than racing.
    const secondPromise = client.auth.loginWithPopup();

    // One window, one launch — the second call opened nothing.
    expect(opened).toHaveLength(1);
    const openedWindow = opened[0];
    if (openedWindow === undefined) throw new Error('expected a window');

    await completeLaunch(emitter, openedWindow.url);
    emitter.emit({ origin: connectOrigin, data: authCallbackMessage });
    const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);
    expect(firstResult).toMatchObject({ status: 'authenticated' });
    expect(secondResult).toBe(firstResult);
  });

  it('releases the in-flight login once it settles', async () => {
    vi.useFakeTimers();
    try {
      const { client, opened } = createLoginTestClient();

      const closeWindowAt = (index: number): void => {
        const openedWindow = opened[index];
        if (openedWindow === undefined) {
          throw new Error(`expected a window at index ${index}`);
        }
        openedWindow.popup.closed = true;
      };

      const firstPromise = client.auth.login();
      expect(opened).toHaveLength(1);
      closeWindowAt(0);
      await vi.advanceTimersByTimeAsync(2000);
      await expect(firstPromise).resolves.toEqual({ status: 'cancelled' });

      // The lock is gone: a later login starts its own window.
      const secondPromise = client.auth.login();
      expect(opened).toHaveLength(2);
      closeWindowAt(1);
      await vi.advanceTimersByTimeAsync(2000);
      await expect(secondPromise).resolves.toEqual({ status: 'cancelled' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('forwards an abort signal to every request the caller waits on', async () => {
    // The timeouts are only real if the signal actually reaches fetch.
    const signalsByPath = new Map<string, AbortSignal | null | undefined>();
    const { client, emitter, opened } = createLoginTestClient({
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
        return completedIntentStatusResponse(request);
      },
    });

    const resultPromise = client.auth.login();
    const openedWindow = opened[0];
    if (openedWindow === undefined) throw new Error('expected a window');
    await completeLaunch(emitter, openedWindow.url);
    emitter.emit({ origin: connectOrigin, data: authCallbackMessage });
    await expect(resultPromise).resolves.toMatchObject({ status: 'authenticated' });

    for (const path of [
      '/v1/connect/auth/exchange',
      '/v1/connect/users/me',
    ]) {
      expect(signalsByPath.get(path)).toBeInstanceOf(AbortSignal);
    }
  });

  it('times out a completion the backend never answers', async () => {
    vi.useFakeTimers();
    try {
      const sessionChanges: Array<string | undefined> = [];
      let releaseExchange: (() => void) | undefined;
      const { client, emitter, opened } = createLoginTestClient({
        fetch: async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);
          if (request.url.endsWith('/v1/connect/auth/exchange')) {
            await new Promise<void>((resolve) => {
              releaseExchange = resolve;
            });
            return sessionResponse();
          }
          return completedIntentStatusResponse(request);
        },
      });
      client.auth.onChange((session) => {
        sessionChanges.push(session?.sessionId);
      });

      const resultPromise = client.auth.login();
      // Capture the outcome now: the rejection lands while the test is still
      // advancing timers, and an unobserved rejection is reported as an
      // unhandled error. Real callers await the call immediately.
      const outcome = resultPromise.catch((error: unknown) => error);
      const openedWindow = opened[0];
      if (openedWindow === undefined) throw new Error('expected a window');
      emitter.emit(launchCreatedMessage(openedWindow.url));
      await vi.advanceTimersByTimeAsync(0);

      emitter.emit({ origin: connectOrigin, data: authCallbackMessage });
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
    let releaseExchange: (() => void) | undefined;
    const sessionChanges: Array<string | undefined> = [];
    const { client, emitter, opened } = createLoginTestClient({
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (request.url.endsWith('/v1/connect/auth/exchange')) {
          await new Promise<void>((resolve) => {
            releaseExchange = resolve;
          });
          return sessionResponse();
        }
        return completedIntentStatusResponse(request);
      },
    });
    client.auth.onChange((session) => {
      sessionChanges.push(session?.sessionId);
    });

    const resultPromise = client.auth.login();
    const openedWindow = opened[0];
    if (openedWindow === undefined) throw new Error('expected a window');
    await completeLaunch(emitter, openedWindow.url);
    emitter.emit({ origin: connectOrigin, data: authCallbackMessage });
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

  it('cancels the login when logout lands while the launch is in flight', async () => {
    // The generation check runs between the launch report and the watch: a
    // logout during creation must close the window, not proceed to a login
    // the user already walked away from.
    const { client, emitter, opened } = createLoginTestClient();

    const resultPromise = client.auth.login();
    const openedWindow = opened[0];
    if (openedWindow === undefined) throw new Error('expected a window');
    client.auth.logout();
    emitter.emit(launchCreatedMessage(openedWindow.url));

    await expect(resultPromise).resolves.toEqual({ status: 'cancelled' });
    expect(openedWindow.popup.closed).toBe(true);
  });

  it('does not let one client instance suppress another client\'s in-flight exchange', async () => {
    // Two clients with independent session storage are independent sessions; a
    // logout on one must not drop a login committing on the other.
    let releaseExchangeB: (() => void) | undefined;
    const emitterB = createMessageEmitter();
    const recorderB = createPopupOpenRecorder();
    const buildClient = (
      key: string,
      storage: ConnectSessionStorage,
      hangExchange: boolean,
    ): ReturnType<typeof createSuperRareClient> =>
      createSuperRareClient({
        apiUrl: 'https://rare-api.test',
        connectUrl: connectOrigin,
        createState: () => 'state_login',
        popup: { open: recorderB.open, messageEvents: emitterB.messageEvents },
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
          return completedIntentStatusResponse(request);
        },
        sessionStorageKey: key,
        sessionStorage: storage,
      });

    const clientA = buildClient('sr.a', createMemoryStorage(), false);
    const clientB = buildClient('sr.b', createMemoryStorage(), true);

    // B's login has its callback and the exchange is in flight, hung.
    const bPromise = clientB.auth.login();
    const openedWindow = recorderB.opened[0];
    if (openedWindow === undefined) throw new Error('expected a window');
    await completeLaunch(emitterB, openedWindow.url);
    emitterB.emit({ origin: connectOrigin, data: authCallbackMessage });
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
    // Every other test injects a fake messageEvents; this one exercises the
    // real globalThis.addEventListener/removeEventListener adapter, across
    // both subscriptions (launch report, then auth callback).
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
      const recorder = createPopupOpenRecorder();
      const client = createSuperRareClient({
        apiUrl: 'https://rare-api.test',
        connectUrl: connectOrigin,
        createState: () => 'state_login',
        // No messageEvents override → the default browser adapter is used.
        popup: { open: recorder.open },
        fetch: async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);
          if (request.url.endsWith('/v1/connect/auth/exchange')) return sessionResponse();
          if (request.url.endsWith('/v1/connect/users/me')) return jsonResponse({ error: 'nope' }, { status: 500 });
          return completedIntentStatusResponse(request);
        },
        sessionStorage: createMemoryStorage(),
      });

      const resultPromise = client.auth.login();
      const openedWindow = recorder.opened[0];
      if (openedWindow === undefined) throw new Error('expected a window');
      expect(listeners.has('message')).toBe(true);

      // Deliver the launch report the way the browser would.
      listeners.get('message')?.(launchCreatedMessage(openedWindow.url));

      // The launch listener unsubscribed; the login watcher subscribes next.
      await vi.waitFor(() => {
        expect(listeners.has('message')).toBe(true);
      });
      listeners.get('message')?.({
        origin: connectOrigin,
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
    // The central invariant: once the session is committed the completion
    // deadline stops applying, so a slow (not failed) /users/me cannot turn
    // a succeeded login into a timeout rejection.
    vi.useFakeTimers();
    try {
      let releaseProfile: (() => void) | undefined;
      const { client, emitter, opened } = createLoginTestClient({
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
          return completedIntentStatusResponse(request);
        },
      });

      const resultPromise = client.auth.login();
      let settledStatus: string | undefined;
      void resultPromise.then((result) => {
        settledStatus = result.status;
      });

      const openedWindow = opened[0];
      if (openedWindow === undefined) throw new Error('expected a window');
      emitter.emit(launchCreatedMessage(openedWindow.url));
      await vi.advanceTimersByTimeAsync(1);
      emitter.emit({ origin: connectOrigin, data: authCallbackMessage });
      // Let the exchange resolve and commit; the profile lookup then hangs.
      await vi.advanceTimersByTimeAsync(0);
      expect(releaseProfile).toBeDefined();
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

  it('settles even if closing the window throws while finishing the login', async () => {
    // An integrator-supplied window whose close() throws must not leave the
    // login promise pending forever (which would also wedge the serialization
    // lock).
    const emitter = createMessageEmitter();
    const opened: string[] = [];
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
      connectUrl: connectOrigin,
      createState: () => 'state_login',
      popup: {
        open: (url) => {
          opened.push(url);
          return popup;
        },
        messageEvents: emitter.messageEvents,
      },
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (request.url.endsWith('/v1/connect/auth/exchange')) return sessionResponse();
        if (request.url.endsWith('/v1/connect/users/me')) return jsonResponse({ error: 'nope' }, { status: 500 });
        return completedIntentStatusResponse(request);
      },
      sessionStorage: createMemoryStorage(),
    });

    const resultPromise = client.auth.login();
    const openedUrl = opened[0];
    if (openedUrl === undefined) throw new Error('expected a window');
    await completeLaunch(emitter, openedUrl);
    emitter.emit({ origin: connectOrigin, data: authCallbackMessage });

    await expect(resultPromise).resolves.toMatchObject({ status: 'authenticated' });
  });

  it('exchanges an in-hand callback even when the intent expiry is behind the client clock', async () => {
    // Client clock ahead of the server: the reported expiresAt is already in
    // the past locally, but a callback in hand must still be exchanged — the
    // server, not the client clock, decides expiry. (Regression: the handler
    // used to discard the callback as `expired`.)
    const exchangeRequests: string[] = [];
    const { client, emitter, opened } = createLoginTestClient({
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (request.url.endsWith('/v1/connect/auth/exchange')) {
          exchangeRequests.push(request.url);
          return sessionResponse();
        }
        if (request.url.endsWith('/v1/connect/users/me')) return jsonResponse({ error: 'nope' }, { status: 500 });
        return completedIntentStatusResponse(request);
      },
    });

    const resultPromise = client.auth.login();
    const openedWindow = opened[0];
    if (openedWindow === undefined) throw new Error('expected a window');
    await completeLaunch(emitter, openedWindow.url, {
      expiresAt: '2020-01-01T00:00:00.000Z',
    });
    emitter.emit({ origin: connectOrigin, data: authCallbackMessage });

    await expect(resultPromise).resolves.toMatchObject({ status: 'authenticated' });
    expect(exchangeRequests).toHaveLength(1);
  });

  it('falls back to a bounded deadline when the intent expiry is unparseable', async () => {
    vi.useFakeTimers();
    try {
      const { client, emitter, opened } = createLoginTestClient();

      const resultPromise = client.auth.login();
      const openedWindow = opened[0];
      if (openedWindow === undefined) throw new Error('expected a window');
      emitter.emit(launchCreatedMessage(openedWindow.url, { expiresAt: 'not-a-date' }));
      await vi.advanceTimersByTimeAsync(14 * 60_000);
      expect(openedWindow.popup.closed).toBe(false);
      await vi.advanceTimersByTimeAsync(2 * 60_000);

      await expect(resultPromise).resolves.toEqual({ status: 'expired' });
      expect(openedWindow.popup.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the login when logout happens before the callback arrives', async () => {
    const { client, emitter, opened } = createLoginTestClient();

    const resultPromise = client.auth.login();
    const openedWindow = opened[0];
    if (openedWindow === undefined) throw new Error('expected a window');
    emitter.emit(launchCreatedMessage(openedWindow.url));
    await vi.waitFor(() => {
      expect(emitter.listenerCount()).toBe(1);
    });
    client.auth.logout();
    emitter.emit({ origin: connectOrigin, data: authCallbackMessage });

    await expect(resultPromise).resolves.toEqual({ status: 'cancelled' });
    expect(client.auth.getSession()).toBeUndefined();
  });

  it('keeps the login authenticated when logout happens during the profile lookup', async () => {
    // Once the session is committed the login has succeeded; a logout during
    // the best-effort profile lookup is a later event (login, then logout),
    // not a reason to report the login as failed.
    let releaseProfile: (() => void) | undefined;
    const { client, emitter, opened } = createLoginTestClient({
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
        return completedIntentStatusResponse(request);
      },
    });

    const resultPromise = client.auth.login();
    const openedWindow = opened[0];
    if (openedWindow === undefined) throw new Error('expected a window');
    await completeLaunch(emitter, openedWindow.url);
    emitter.emit({ origin: connectOrigin, data: authCallbackMessage });
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
    vi.useFakeTimers();
    try {
      const emitter = createMessageEmitter();
      const recorder = createPopupOpenRecorder();
      const buildClient = (): ReturnType<typeof createSuperRareClient> =>
        createSuperRareClient({
          apiUrl: 'https://rare-api.test',
          connectUrl: connectOrigin,
          createState: () => 'state_login',
          popup: { open: recorder.open, messageEvents: emitter.messageEvents },
          fetch: async (input, init) => {
            const request = input instanceof Request ? input : new Request(input, init);
            return completedIntentStatusResponse(request);
          },
          sessionStorage: createMemoryStorage(),
        });

      // Serialization is per client, so two clients on one page can still have
      // a login each — they must not share a window name.
      const firstPromise = buildClient().auth.login();
      const secondPromise = buildClient().auth.login();
      expect(recorder.opened).toHaveLength(2);
      expect(new Set(recorder.opened.map(({ target }) => target)).size).toBe(2);

      // Settle both so neither watcher outlives the test.
      recorder.opened.forEach(({ popup }) => {
        popup.closed = true;
      });
      await vi.advanceTimersByTimeAsync(2000);
      await expect(firstPromise).resolves.toEqual({ status: 'cancelled' });
      await expect(secondPromise).resolves.toEqual({ status: 'cancelled' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a reported login URL that is not a web URL, and closes the window', async () => {
    const { client, emitter, opened } = createLoginTestClient();

    const resultPromise = client.auth.login();
    const openedWindow = opened[0];
    if (openedWindow === undefined) throw new Error('expected a window');
    emitter.emit(launchCreatedMessage(openedWindow.url, { url: 'not a url' }));

    await expect(resultPromise).rejects.toThrow('Invalid Connect intent URL');
    expect(openedWindow.popup.closed).toBe(true);
    expect(emitter.listenerCount()).toBe(0);
  });
});

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json' },
  });
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
