import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConnectAuthCallbackError,
  ConnectAuthPendingError,
  createSuperRareClient,
  type ConnectSessionStorage,
} from '../src/index.js';

const futureExpiry = (): string => new Date(Date.now() + 30 * 60_000).toISOString();

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json' },
  });
}

function memoryStorage(): ConnectSessionStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

function intentCreationResponse(intentId: string, path = 'intents'): Response {
  return jsonResponse({
    data: {
      intentId,
      url: path === 'login'
        ? `https://connect.superrare.test/login?intentId=${intentId}`
        : `https://connect.superrare.test/${path}/${intentId}`,
      expiresAt: futureExpiry(),
    },
  });
}

function intentResponse(intentId: string, status: string): Response {
  return jsonResponse({
    data: {
      intentId,
      type: 'buy',
      status,
      returnPath: '/buy/complete',
      expiresAt: futureExpiry(),
    },
  });
}

const buyParams = {
  target: {
    kind: 'erc721-direct-listing',
    chainId: 1,
    contract: '0x252f829f6ea6623c883d6f433dc6999b94817419',
    tokenId: '1',
  },
  expected: { currency: 'ETH', price: '1000000000000' },
  returnPath: '/buy/complete',
} as const;

const transferParams = {
  chainId: 1,
  to: '0x52908400098527886E0F7030069857D2E4169EE7',
  currency: 'USDC',
  amount: '25000000',
  returnPath: '/credits/complete',
} as const;

describe('display: redirect actions', () => {
  it('navigates the page to the hosted action without opening a window', async () => {
    const assign = vi.fn<(url: string) => void>();
    const open = vi.fn(() => null);
    const storage = memoryStorage();
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      display: 'redirect',
      navigation: { assign },
      popup: { open },
      sessionStorage: storage,
      createState: () => 'state_buy',
      fetch: async () => intentCreationResponse('connect_intent_buy'),
    });

    await expect(client.actions.buy(buyParams)).resolves.toMatchObject({
      intentId: 'connect_intent_buy',
    });

    expect(open).not.toHaveBeenCalled();
    expect(assign).toHaveBeenCalledWith('https://connect.superrare.test/intents/connect_intent_buy');
  });

  it('runs beforeOpen before navigating and does not navigate when it fails', async () => {
    const order: string[] = [];
    const assign = vi.fn<(url: string) => void>(() => { order.push('assign'); });
    const linkingFailed = new Error('order link failed');
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      display: 'redirect',
      navigation: { assign },
      sessionStorage: memoryStorage(),
      fetch: async () => intentCreationResponse('connect_intent_transfer'),
    });

    await client.actions.transfer({
      ...transferParams,
      beforeOpen: () => { order.push('beforeOpen'); },
    });
    expect(order).toEqual(['beforeOpen', 'assign']);

    assign.mockClear();
    await expect(client.actions.transfer({
      ...transferParams,
      beforeOpen: async () => { throw linkingFailed; },
    })).rejects.toBe(linkingFailed);
    expect(assign).not.toHaveBeenCalled();
  });

  it('reads the redirected intent back on the return page and forgets it once final', async () => {
    const storage = memoryStorage();
    const statuses = ['processing', 'completed'];
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method === 'POST') return intentCreationResponse('connect_intent_buy');
      expect(request.url).toBe('https://rare-api.test/v1/connect/intents/connect_intent_buy');
      return intentResponse('connect_intent_buy', statuses.shift() ?? 'completed');
    });
    const options = {
      apiUrl: 'https://rare-api.test',
      display: 'redirect',
      navigation: { assign: () => {} },
      sessionStorage: storage,
      fetch: fetchImplementation,
    } as const;
    await createSuperRareClient(options).actions.buy(buyParams);

    const returnPage = createSuperRareClient(options);
    await expect(returnPage.intents.getRedirectResult()).resolves.toMatchObject({ status: 'processing' });
    await expect(returnPage.intents.getRedirectResult()).resolves.toMatchObject({ status: 'completed' });
    await expect(returnPage.intents.getRedirectResult()).resolves.toBeUndefined();
  });

  it('returns undefined when no redirect was started', async () => {
    const fetchImplementation = vi.fn();
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      display: 'redirect',
      sessionStorage: memoryStorage(),
      fetch: fetchImplementation,
    });

    await expect(client.intents.getRedirectResult()).resolves.toBeUndefined();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('forgets a redirected intent Rare API no longer serves', async () => {
    const storage = memoryStorage();
    let gone = false;
    const options = {
      apiUrl: 'https://rare-api.test',
      display: 'redirect',
      navigation: { assign: () => {} },
      sessionStorage: storage,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (request.method === 'POST') return intentCreationResponse('connect_intent_buy');
        gone = true;
        return jsonResponse({ error: 'Connect intent expired' }, { status: 410 });
      },
    } as const;
    await createSuperRareClient(options).actions.buy(buyParams);

    const returnPage = createSuperRareClient(options);
    await expect(returnPage.intents.getRedirectResult()).rejects.toMatchObject({ status: 410 });
    expect(gone).toBe(true);
    await expect(returnPage.intents.getRedirectResult()).resolves.toBeUndefined();
  });
  it('keeps a newer redirected intent when an older read finishes', async () => {
    let releaseRead: () => void = () => {};
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const createdIntents = ['connect_intent_first', 'connect_intent_second'];
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      display: 'redirect',
      navigation: { assign: () => {} },
      sessionStorage: memoryStorage(),
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (request.method === 'POST') return intentCreationResponse(createdIntents.shift() ?? 'connect_intent_extra');
        const intentId = new URL(request.url).pathname.split('/').at(-1) ?? '';
        if (intentId === 'connect_intent_first') await readGate;
        return intentResponse(intentId, intentId === 'connect_intent_first' ? 'completed' : 'processing');
      },
    });
    await client.actions.buy(buyParams);

    const olderRead = client.intents.getRedirectResult();
    await client.actions.buy(buyParams);
    releaseRead();

    await expect(olderRead).resolves.toMatchObject({ intentId: 'connect_intent_first' });
    await expect(client.intents.getRedirectResult()).resolves.toMatchObject({ intentId: 'connect_intent_second' });
  });
});

describe('display: redirect storage and guards', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps redirect records in the tab, not in the shared session storage', async () => {
    const tabStorage = memoryStorage();
    const sharedStorage = memoryStorage();
    vi.stubGlobal('sessionStorage', tabStorage);
    vi.stubGlobal('localStorage', sharedStorage);
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      display: 'redirect',
      navigation: { assign: () => {} },
      fetch: async () => intentCreationResponse('connect_intent_buy'),
    });

    await client.actions.buy(buyParams);

    expect([...tabStorage.values.values()]).toEqual([JSON.stringify({ intentId: 'connect_intent_buy' })]);
    expect(sharedStorage.values.size).toBe(0);
  });

  it('keeps redirect records in the tab even when a shared storage is injected', async () => {
    const tabStorage = memoryStorage();
    const injectedStorage = memoryStorage();
    vi.stubGlobal('sessionStorage', tabStorage);
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      display: 'redirect',
      navigation: { assign: () => {} },
      sessionStorage: injectedStorage,
      fetch: async () => intentCreationResponse('connect_intent_buy'),
    });

    await client.actions.buy(buyParams);

    expect([...tabStorage.values.values()]).toEqual([JSON.stringify({ intentId: 'connect_intent_buy' })]);
    expect(injectedStorage.values.size).toBe(0);
  });

  it('refuses a redirect without navigation before creating an intent or running beforeOpen', async () => {
    const fetchImplementation = vi.fn();
    const beforeOpen = vi.fn();
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      display: 'redirect',
      sessionStorage: memoryStorage(),
      fetch: fetchImplementation,
    });

    await expect(client.actions.transfer({ ...transferParams, beforeOpen }))
      .rejects.toThrow('Redirect display needs window.location');
    await expect(client.auth.login()).rejects.toThrow('Redirect display needs window.location');
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(beforeOpen).not.toHaveBeenCalled();
  });

  it('never navigates the page to a non-web hosted URL', async () => {
    const assign = vi.fn<(url: string) => void>();
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      display: 'redirect',
      navigation: { assign },
      sessionStorage: memoryStorage(),
      fetch: async () => jsonResponse({
        data: { intentId: 'connect_intent_evil', url: 'javascript:alert(1)', expiresAt: futureExpiry() },
      }),
    });

    await expect(client.actions.buy(buyParams)).rejects.toThrow('Invalid Connect intent URL');
    await expect(client.auth.login()).rejects.toThrow('Invalid Connect intent URL');
    expect(assign).not.toHaveBeenCalled();
  });

  it('keeps the redirected intent when Rare API fails transiently', async () => {
    let failures = 1;
    const options = {
      apiUrl: 'https://rare-api.test',
      display: 'redirect',
      navigation: { assign: () => {} },
      sessionStorage: memoryStorage(),
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (request.method === 'POST') return intentCreationResponse('connect_intent_buy');
        if (failures > 0) {
          failures -= 1;
          return jsonResponse({ error: 'unavailable' }, { status: 503 });
        }
        return intentResponse('connect_intent_buy', 'completed');
      },
    } as const;
    await createSuperRareClient(options).actions.buy(buyParams);

    const returnPage = createSuperRareClient(options);
    await expect(returnPage.intents.getRedirectResult()).rejects.toMatchObject({ status: 503 });
    await expect(returnPage.intents.getRedirectResult()).resolves.toMatchObject({ status: 'completed' });
  });
});

describe('display: redirect login', () => {
  const loginFetch = (requests: string[]) => async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(new URL(request.url).pathname);
    if (request.url.endsWith('/v1/connect/auth/exchange')) {
      return jsonResponse({
        data: {
          session: {
            sessionId: 'connect_session_login',
            userId: 'user_login',
            address: '0x0000000000000000000000000000000000000009',
            expiresAt: futureExpiry(),
          },
          refreshToken: 'connect_refresh_login',
          refreshExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(),
        },
      });
    }
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
    return intentCreationResponse('connect_intent_login', 'login');
  };

  it('navigates to the hosted login and resolves redirected', async () => {
    const assign = vi.fn<(url: string) => void>();
    const open = vi.fn(() => null);
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      display: 'redirect',
      navigation: { assign },
      popup: { open },
      sessionStorage: memoryStorage(),
      createState: () => 'state_login',
      fetch: loginFetch([]),
    });

    await expect(client.auth.login({ returnPath: '/auth/callback' })).resolves.toEqual({
      status: 'redirected',
    });
    expect(open).not.toHaveBeenCalled();
    expect(assign).toHaveBeenCalledWith('https://connect.superrare.test/login?intentId=connect_intent_login');
  });

  it('exchanges the callback on the return page and stores the session', async () => {
    const storage = memoryStorage();
    const requests: string[] = [];
    const options = {
      apiUrl: 'https://rare-api.test',
      display: 'redirect',
      navigation: { assign: () => {} },
      sessionStorage: storage,
      createState: () => 'state_login',
      fetch: loginFetch(requests),
    } as const;
    await createSuperRareClient(options).auth.login({ returnPath: '/auth/callback' });

    const returnPage = createSuperRareClient(options);
    const result = await returnPage.auth.handleRedirectCallback(
      new URLSearchParams('intentId=connect_intent_login&state=state_login&code=one_time_code'),
    );

    expect(result).toMatchObject({
      status: 'authenticated',
      session: { address: '0x0000000000000000000000000000000000000009' },
      user: { username: 'collector' },
    });
    expect(returnPage.auth.getSession()?.sessionId).toBe('connect_session_login');
    expect(requests).toContain('/v1/connect/auth/exchange');
    await expect(returnPage.auth.handleRedirectCallback(
      new URLSearchParams('intentId=connect_intent_login&state=state_login&code=replayed_code'),
    )).rejects.toMatchObject({ code: 'missing_pending_auth' });
  });

  it('refuses a callback whose state does not match the login this browser started', async () => {
    const requests: string[] = [];
    const options = {
      apiUrl: 'https://rare-api.test',
      display: 'redirect',
      navigation: { assign: () => {} },
      sessionStorage: memoryStorage(),
      createState: () => 'state_login',
      fetch: loginFetch(requests),
    } as const;
    await createSuperRareClient(options).auth.login({ returnPath: '/auth/callback' });

    const returnPage = createSuperRareClient(options);
    const callback = returnPage.auth.handleRedirectCallback(
      new URLSearchParams('intentId=connect_intent_login&state=forged_state&code=one_time_code'),
    );
    await expect(callback).rejects.toBeInstanceOf(ConnectAuthPendingError);
    await expect(callback).rejects.toMatchObject({ code: 'state_mismatch' });
    expect(requests).not.toContain('/v1/connect/auth/exchange');
    expect(returnPage.auth.getSession()).toBeUndefined();
  });

  it('rejects a malformed callback before checking the pending login', async () => {
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      display: 'redirect',
      sessionStorage: memoryStorage(),
      fetch: vi.fn(),
    });

    const callback = client.auth.handleRedirectCallback(new URLSearchParams('intentId=connect_intent_login&state=s'));
    await expect(callback).rejects.toBeInstanceOf(ConnectAuthCallbackError);
    await expect(callback).rejects.toMatchObject({ code: 'missing_code' });
  });

  it('navigates to a prepared login intent without the popup display', async () => {
    const assign = vi.fn<(url: string) => void>();
    const requests: string[] = [];
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      display: 'redirect',
      navigation: { assign },
      sessionStorage: memoryStorage(),
      fetch: loginFetch(requests),
    });

    await client.auth.prepareLogin();
    await client.auth.login();

    expect(requests.filter((path) => path === '/v1/connect/intents')).toHaveLength(1);
    expect(assign).toHaveBeenCalledWith('https://connect.superrare.test/login?intentId=connect_intent_login');
  });

  it('does not store a session when a logout lands during the exchange', async () => {
    const storage = memoryStorage();
    let releaseExchange: () => void = () => {};
    const exchangeGate = new Promise<void>((resolve) => { releaseExchange = resolve; });
    const baseFetch = loginFetch([]);
    const options = {
      apiUrl: 'https://rare-api.test',
      display: 'redirect',
      navigation: { assign: () => {} },
      sessionStorage: storage,
      createState: () => 'state_login',
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith('/v1/connect/auth/exchange')) await exchangeGate;
        if (url.endsWith('/v1/connect/auth/logout')) return jsonResponse({ data: { revoked: true } });
        return await baseFetch(input, init);
      },
    } as const;
    await createSuperRareClient(options).auth.login();

    const returnPage = createSuperRareClient(options);
    const callback = returnPage.auth.handleRedirectCallback(
      new URLSearchParams('intentId=connect_intent_login&state=state_login&code=one_time_code'),
    );
    await returnPage.auth.logout();
    releaseExchange();

    await expect(callback).resolves.toEqual({ status: 'cancelled' });
    expect(returnPage.auth.getSession()).toBeUndefined();
  });

  it('does not navigate when a logout lands while the login intent is created', async () => {
    let releaseIntent: () => void = () => {};
    const intentGate = new Promise<void>((resolve) => { releaseIntent = resolve; });
    const assign = vi.fn<(url: string) => void>();
    const baseFetch = loginFetch([]);
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      display: 'redirect',
      navigation: { assign },
      sessionStorage: memoryStorage(),
      createState: () => 'state_login',
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        await intentGate;
        return await baseFetch(input, init);
      },
    });

    const login = client.auth.login();
    await client.auth.logout();
    releaseIntent();

    await expect(login).resolves.toEqual({ status: 'cancelled' });
    expect(assign).not.toHaveBeenCalled();
  });

  it('does not overwrite a session another tab stored during the exchange', async () => {
    const credentialStorage = memoryStorage();
    let releaseFirstExchange: () => void = () => {};
    const firstExchangeGate = new Promise<void>((resolve) => { releaseFirstExchange = resolve; });
    const exchangeFor = (code: string) => jsonResponse({
      data: {
        session: {
          sessionId: `connect_session_${code}`,
          userId: `user_${code}`,
          address: '0x0000000000000000000000000000000000000009',
          expiresAt: futureExpiry(),
        },
        refreshToken: `connect_refresh_${code}`,
        refreshExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(),
      },
    });
    const baseFetch = loginFetch([]);
    const options = {
      apiUrl: 'https://rare-api.test',
      display: 'redirect',
      navigation: { assign: () => {} },
      sessionStorage: credentialStorage,
      createState: () => 'state_login',
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (request.url.endsWith('/v1/connect/auth/exchange')) {
          const body: unknown = await request.clone().json();
          const code = typeof body === 'object' && body !== null && 'code' in body && typeof body.code === 'string'
            ? body.code
            : '';
          if (code === 'first_tab_code') await firstExchangeGate;
          return exchangeFor(code);
        }
        return await baseFetch(input, init);
      },
    } as const;

    vi.stubGlobal('sessionStorage', memoryStorage());
    await createSuperRareClient(options).auth.login();
    const firstTab = createSuperRareClient(options);
    vi.stubGlobal('sessionStorage', memoryStorage());
    await createSuperRareClient(options).auth.login();
    const secondTab = createSuperRareClient(options);

    const firstCallback = firstTab.auth.handleRedirectCallback(
      new URLSearchParams('intentId=connect_intent_login&state=state_login&code=first_tab_code'),
    );
    await expect(secondTab.auth.handleRedirectCallback(
      new URLSearchParams('intentId=connect_intent_login&state=state_login&code=second_tab_code'),
    )).resolves.toMatchObject({ status: 'authenticated' });
    releaseFirstExchange();

    await expect(firstCallback).resolves.toEqual({ status: 'cancelled' });
    expect(secondTab.auth.getSession()?.sessionId).toBe('connect_session_second_tab_code');
    vi.unstubAllGlobals();
  });

  it('lets a newer login on the return page win over the callback still exchanging', async () => {
    let releaseExchange: () => void = () => {};
    const exchangeGate = new Promise<void>((resolve) => { releaseExchange = resolve; });
    let releaseIntent: () => void = () => {};
    const intentGate = new Promise<void>((resolve) => { releaseIntent = resolve; });
    const assign = vi.fn<(url: string) => void>();
    const states = ['state_older', 'state_newer'];
    const baseFetch = loginFetch([]);
    let gateIntents = false;
    const options = {
      apiUrl: 'https://rare-api.test',
      display: 'redirect',
      navigation: { assign },
      sessionStorage: memoryStorage(),
      createState: () => states.shift() ?? 'state_extra',
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith('/v1/connect/auth/exchange')) await exchangeGate;
        if (url.endsWith('/v1/connect/intents') && gateIntents) await intentGate;
        return await baseFetch(input, init);
      },
    } as const;
    await createSuperRareClient(options).auth.login();
    assign.mockClear();

    const returnPage = createSuperRareClient(options);
    const callback = returnPage.auth.handleRedirectCallback(
      new URLSearchParams('intentId=connect_intent_login&state=state_older&code=one_time_code'),
    );
    gateIntents = true;
    const newerLogin = returnPage.auth.login();
    releaseExchange();
    await expect(callback).resolves.toEqual({ status: 'cancelled' });
    releaseIntent();

    await expect(newerLogin).resolves.toEqual({ status: 'redirected' });
    expect(assign).toHaveBeenCalledTimes(1);
    expect(returnPage.auth.getSession()).toBeUndefined();
  });

  it('keeps the pending record of a newer login when an older callback finishes', async () => {
    let releaseExchange: () => void = () => {};
    const exchangeGate = new Promise<void>((resolve) => { releaseExchange = resolve; });
    const states = ['state_older', 'state_newer'];
    const baseFetch = loginFetch([]);
    let gateExchange = true;
    const options = {
      apiUrl: 'https://rare-api.test',
      display: 'redirect',
      navigation: { assign: () => {} },
      sessionStorage: memoryStorage(),
      createState: () => states.shift() ?? 'state_extra',
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith('/v1/connect/auth/exchange') && gateExchange) await exchangeGate;
        return await baseFetch(input, init);
      },
    } as const;
    await createSuperRareClient(options).auth.login();

    const returnPage = createSuperRareClient(options);
    const olderCallback = returnPage.auth.handleRedirectCallback(
      new URLSearchParams('intentId=connect_intent_login&state=state_older&code=older_code'),
    );
    await returnPage.auth.login();
    releaseExchange();
    await expect(olderCallback).resolves.toEqual({ status: 'cancelled' });

    gateExchange = false;
    await expect(createSuperRareClient(options).auth.handleRedirectCallback(
      new URLSearchParams('intentId=connect_intent_login&state=state_newer&code=newer_code'),
    )).resolves.toMatchObject({ status: 'authenticated' });
  });

  it('joins a second login click instead of cancelling the first', async () => {
    const assign = vi.fn<(url: string) => void>();
    const requests: string[] = [];
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      display: 'redirect',
      navigation: { assign },
      sessionStorage: memoryStorage(),
      fetch: loginFetch(requests),
    });

    const [first, second] = await Promise.all([client.auth.login(), client.auth.login()]);

    expect(first).toEqual({ status: 'redirected' });
    expect(second).toEqual({ status: 'redirected' });
    expect(requests.filter((path) => path === '/v1/connect/intents')).toHaveLength(1);
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it('lets the same callback retry after a failed exchange', async () => {
    let exchangeAttempts = 0;
    const baseFetch = loginFetch([]);
    const options = {
      apiUrl: 'https://rare-api.test',
      display: 'redirect',
      navigation: { assign: () => {} },
      sessionStorage: memoryStorage(),
      createState: () => 'state_login',
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith('/v1/connect/auth/exchange')) {
          exchangeAttempts += 1;
          if (exchangeAttempts === 1) throw new TypeError('Failed to fetch');
        }
        return await baseFetch(input, init);
      },
    } as const;
    await createSuperRareClient(options).auth.login();

    const returnPage = createSuperRareClient(options);
    const callback = new URLSearchParams('intentId=connect_intent_login&state=state_login&code=one_time_code');
    await expect(returnPage.auth.handleRedirectCallback(callback)).rejects.toThrow();

    await expect(returnPage.auth.handleRedirectCallback(new URLSearchParams(callback)))
      .resolves.toMatchObject({ status: 'authenticated' });
    expect(exchangeAttempts).toBe(2);
  });

  it('joins a second handling of the same callback instead of failing it', async () => {
    const requests: string[] = [];
    const options = {
      apiUrl: 'https://rare-api.test',
      display: 'redirect',
      navigation: { assign: () => {} },
      sessionStorage: memoryStorage(),
      createState: () => 'state_login',
      fetch: loginFetch(requests),
    } as const;
    await createSuperRareClient(options).auth.login();

    const returnPage = createSuperRareClient(options);
    const callback = new URLSearchParams('intentId=connect_intent_login&state=state_login&code=one_time_code');
    const [first, second] = await Promise.all([
      returnPage.auth.handleRedirectCallback(callback),
      returnPage.auth.handleRedirectCallback(new URLSearchParams(callback)),
    ]);

    expect(first).toMatchObject({ status: 'authenticated' });
    expect(second).toBe(first);
    expect(requests.filter((path) => path === '/v1/connect/auth/exchange')).toHaveLength(1);
  });

  it.each([
    ['state=s&code=c', 'missing_intent_id'],
    ['intentId=a&intentId=b&state=s&code=c', 'duplicate_intent_id'],
    ['intentId=a&state=s&state=t&code=c', 'duplicate_state'],
    ['intentId=a&state=%20&code=c', 'malformed_state'],
    ['intentId=a&state=s&code=c%0A', 'malformed_code'],
  ])('rejects the callback %j with %s', async (query, code) => {
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      display: 'redirect',
      sessionStorage: memoryStorage(),
      fetch: vi.fn(),
    });

    await expect(client.auth.handleRedirectCallback(new URLSearchParams(query)))
      .rejects.toMatchObject({ name: 'ConnectAuthCallbackError', code });
  });

  it('refuses a redirect login without storage before creating an intent', async () => {
    const fetchImplementation = vi.fn();
    const assign = vi.fn<(url: string) => void>();
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test',
      display: 'redirect',
      navigation: { assign },
      sessionStorage: false,
      fetch: fetchImplementation,
    });

    await expect(client.auth.login()).rejects.toThrow('redirect login needs SDK storage');
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });
});
