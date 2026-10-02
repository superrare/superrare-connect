import { describe, expect, it, vi } from 'vitest';
import { createSuperRareClient, ConnectPopupBlockedError, ConnectSessionRequiredError, type SuperRareConnectClient } from '../src/client.js';
import type { ConnectAuthCredentials } from '../src/api.js';
import { parseStoredConnectCredentials, type ConnectSessionStorage } from '../src/session-storage-core.js';
import type { ConnectPopupWindow } from '../src/popup-core.js';

const apiUrl = 'https://rare-api.test';
const storageKey = 'superrare.connect.session:https%3A%2F%2Frare-api.test';
const user = { address: '0x0000000000000000000000000000000000000001', username: 'artist', fullName: null, avatarUri: null };

function credentials(input: {
  sessionId?: string;
  refreshToken?: string;
  accessRemaining?: number;
  refreshRemaining?: number;
} = {}): ConnectAuthCredentials {
  return {
    session: {
      sessionId: input.sessionId ?? 'access_original',
      userId: 'user_123',
      address: user.address,
      expiresAt: new Date(Date.now() + (input.accessRemaining ?? 60 * 60_000)).toISOString(),
    },
    refreshToken: input.refreshToken ?? 'refresh_original',
    refreshExpiresAt: new Date(Date.now() + (input.refreshRemaining ?? 30 * 24 * 60 * 60_000)).toISOString(),
  };
}

function storageAdapter(values: Map<string, string> = new Map()): ConnectSessionStorage {
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

function seed(storage: ConnectSessionStorage, value: ConnectAuthCredentials): void {
  storage.setItem(storageKey, JSON.stringify(value));
}

function storedCredentials(storage: ConnectSessionStorage): ConnectAuthCredentials | undefined {
  const serialized = storage.getItem(storageKey);
  return serialized === null ? undefined : parseStoredConnectCredentials(serialized);
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((done) => { resolve = done; });
  return {
    promise,
    resolve(value) {
      if (resolve === undefined) throw new Error('Deferred promise was not initialized.');
      resolve(value);
    },
  };
}

function loginHarness(input: {
  storage: ConnectSessionStorage | false;
  exchange: ConnectAuthCredentials;
  fetchAuth: (request: Request) => Promise<Response>;
  beforeCallback?: () => Promise<void>;
}): {
  client: SuperRareConnectClient;
  login: () => Promise<void>;
} {
  const listeners = new Set<(event: { origin: string; data: unknown }) => void>();
  let popupOpened = false;
  const popup: ConnectPopupWindow = {
    closed: false,
    close: () => { popup.closed = true; },
    location: { replace: () => { popupOpened = true; } },
  };
  const client = createSuperRareClient({
    apiUrl,
    sessionStorage: input.storage,
    createState: () => 'state_login',
    initiatingOrigin: 'https://app.test',
    popup: {
      open: () => popup,
      messageEvents: { subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; } },
    },
    fetch: async (requestInput, init) => {
      const request = requestInput instanceof Request ? requestInput : new Request(requestInput, init);
      if (request.url.endsWith('/v1/connect/intents')) return response({ data: {
        intentId: 'intent_login',
        url: 'https://connect.superrare.test/login?intentId=intent_login',
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      } });
      if (request.url.endsWith('/v1/connect/auth/exchange')) return response({ data: input.exchange });
      if (request.url.endsWith('/v1/connect/users/me')) return response({ data: user });
      return await input.fetchAuth(request);
    },
  });
  return {
    client,
    async login() {
      const pending = client.auth.login();
      await vi.waitFor(() => expect(popupOpened).toBe(true));
      await input.beforeCallback?.();
      listeners.forEach((listener) => listener({ origin: 'https://connect.superrare.test', data: {
        type: 'superrare-connect:auth-callback', intentId: 'intent_login', state: 'state_login', code: 'code_login',
      } }));
      const result = await pending;
      expect(result.status).toBe('authenticated');
      expect(result).not.toHaveProperty('refreshToken');
      if (result.status === 'authenticated') {
        expect(result.session).toEqual(input.exchange.session);
        expect(result.session).not.toHaveProperty('refreshToken');
      }
    },
  };
}

describe('Connect credential lifecycle', () => {
  it('returns the opaque access token and a stable identity-only snapshot without renewing a fresh session', async () => {
    const storage = storageAdapter();
    const original = credentials();
    seed(storage, original);
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = createSuperRareClient({ apiUrl, sessionStorage: storage, fetch });
    const snapshot = client.auth.getSession();
    expect(snapshot).toEqual(original.session);
    expect(client.auth.getSession()).toBe(snapshot);
    expect(snapshot).not.toHaveProperty('refreshToken');
    expect(snapshot).not.toHaveProperty('refreshExpiresAt');
    await expect(client.auth.getAccessToken()).resolves.toBe(original.session.sessionId);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([30_000, -1])('renews access with %i milliseconds remaining and persists the rotated credential', async (accessRemaining) => {
    const storage = storageAdapter();
    seed(storage, credentials({ accessRemaining }));
    const renewed = credentials({ sessionId: 'access_renewed', refreshToken: 'refresh_renewed' });
    const changes: unknown[] = [];
    const client = createSuperRareClient({ apiUrl, sessionStorage: storage, fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      expect(request.url).toBe(`${apiUrl}/v1/connect/auth/refresh`);
      expect(await request.json()).toEqual({ refreshToken: 'refresh_original' });
      return response({ data: renewed });
    } });
    client.auth.onChange((session) => changes.push(session));
    await expect(client.auth.getAccessToken()).resolves.toBe('access_renewed');
    expect(changes).toEqual([renewed.session]);
    expect(changes[0]).not.toHaveProperty('refreshToken');
    expect(storedCredentials(storage)).toEqual(renewed);
  });

  it('shares one renewal across access-token, profile, remote-session and second-client consumers', async () => {
    const storage = storageAdapter();
    seed(storage, credentials({ accessRemaining: -1 }));
    const gate = deferred<Response>();
    const started = deferred<void>();
    const renewed = credentials({ sessionId: 'access_renewed', refreshToken: 'refresh_renewed' });
    let refreshCount = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url.endsWith('/auth/refresh')) {
        refreshCount += 1;
        started.resolve();
        return await gate.promise;
      }
      expect(request.headers.get('authorization')).toBe('Bearer access_renewed');
      return request.url.endsWith('/users/me') ? response({ data: user })
        : response({ data: { authenticated: true, session: renewed.session } });
    };
    const first = createSuperRareClient({ apiUrl, sessionStorage: storage, fetch });
    const second = createSuperRareClient({ apiUrl, sessionStorage: storage, fetch });
    const pending = Promise.all([first.auth.getAccessToken(), first.auth.me(), first.auth.getRemoteSession(), second.user.me()]);
    await started.promise;
    gate.resolve(response({ data: renewed }));
    await expect(pending).resolves.toEqual(['access_renewed', user, { authenticated: true, session: renewed.session }, user]);
    expect(refreshCount).toBe(1);
    expect(second.auth.getSession()).toBe(first.auth.getSession());
  });

  it('restores the rotated refresh credential through a fresh storage adapter after reload', async () => {
    const values = new Map<string, string>();
    const storage = storageAdapter(values);
    seed(storage, credentials({ accessRemaining: -1 }));
    const renewed = credentials({ sessionId: 'access_renewed', refreshToken: 'refresh_renewed' });
    const first = createSuperRareClient({ apiUrl, sessionStorage: storage, fetch: async () => response({ data: renewed }) });
    await first.auth.getAccessToken();
    const reloadedStorage = storageAdapter(values);
    const latest = credentials({ sessionId: 'access_latest', refreshToken: 'refresh_latest' });
    const reloaded = createSuperRareClient({ apiUrl, sessionStorage: reloadedStorage, fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      expect(await request.json()).toEqual({ refreshToken: 'refresh_renewed' });
      return response({ data: latest });
    } });
    expect(reloaded.auth.getSession()).toEqual(renewed.session);
    seed(reloadedStorage, { ...renewed, session: { ...renewed.session, expiresAt: new Date(Date.now() - 1).toISOString() } });
    await expect(reloaded.auth.getAccessToken()).resolves.toBe('access_latest');
  });

  it('serializes distinct tab adapters with Web Locks and re-reads the winning token inside the lock', async () => {
    const values = new Map<string, string>();
    const firstStorage = storageAdapter(values);
    const secondStorage = storageAdapter(values);
    seed(firstStorage, credentials({ accessRemaining: -1 }));
    const gate = deferred<Response>();
    const started = deferred<void>();
    const renewed = credentials({ sessionId: 'access_renewed', refreshToken: 'refresh_renewed' });
    const names: string[] = [];
    let queue = Promise.resolve();
    vi.stubGlobal('navigator', { locks: { request: <T>(name: string, operation: () => Promise<T>): Promise<T> => {
      names.push(name);
      const pending = queue.then(operation);
      queue = pending.then(() => undefined, () => undefined);
      return pending;
    } } });
    let refreshCount = 0;
    const fetch: typeof globalThis.fetch = async () => {
      refreshCount += 1;
      started.resolve();
      return await gate.promise;
    };
    try {
      const first = createSuperRareClient({ apiUrl, sessionStorage: firstStorage, fetch });
      const second = createSuperRareClient({ apiUrl, sessionStorage: secondStorage, fetch });
      const firstToken = first.auth.getAccessToken();
      await started.promise;
      const secondToken = second.auth.getAccessToken();
      gate.resolve(response({ data: renewed }));
      await expect(Promise.all([firstToken, secondToken])).resolves.toEqual(['access_renewed', 'access_renewed']);
      expect(refreshCount).toBe(1);
      expect(names).toEqual([`superrare.connect.credentials:${storageKey}`, `superrare.connect.credentials:${storageKey}`]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('clears a rejected refresh credential on 401 without retrying its consumed token', async () => {
    const storage = storageAdapter();
    seed(storage, credentials({ accessRemaining: -1 }));
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response({ error: 'invalid credential' }, 401));
    const client = createSuperRareClient({ apiUrl, sessionStorage: storage, fetch });
    await expect(client.auth.getAccessToken()).rejects.toMatchObject({ status: 401 });
    expect(client.auth.getSession()).toBeUndefined();
    expect(storage.getItem(storageKey)).toBeNull();
    await expect(client.auth.getAccessToken()).rejects.toBeInstanceOf(ConnectSessionRequiredError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['network', 'unavailable'])('retains credentials through a %s renewal outage', async (failure) => {
    const storage = storageAdapter();
    const original = credentials({ accessRemaining: -1 });
    seed(storage, original);
    const client = createSuperRareClient({ apiUrl, sessionStorage: storage, fetch: async () => {
      if (failure === 'network') throw new Error('Network unavailable');
      return response({ error: 'storage unavailable' }, 503);
    } });
    const snapshot = client.auth.getSession();
    const pending = client.auth.getAccessToken();
    if (failure === 'network') await expect(pending).rejects.toThrow('Network unavailable');
    else await expect(pending).rejects.toMatchObject({ status: 503 });
    expect(client.auth.getSession()).toBe(snapshot);
    expect(storage.getItem(storageKey)).toBe(JSON.stringify(original));
  });

  it('requires login when the absolute refresh lifetime expires', async () => {
    const storage = storageAdapter();
    seed(storage, credentials({ accessRemaining: -1, refreshRemaining: -1 }));
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = createSuperRareClient({ apiUrl, sessionStorage: storage, fetch });
    await expect(client.auth.getAccessToken()).rejects.toBeInstanceOf(ConnectSessionRequiredError);
    expect(client.auth.getSession()).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not fabricate refresh credentials from a legacy identity-only session', async () => {
    const storage = storageAdapter();
    storage.setItem(storageKey, JSON.stringify(credentials().session));
    const client = createSuperRareClient({ apiUrl, sessionStorage: storage });
    expect(client.auth.getSession()).toBeUndefined();
    await expect(client.auth.getAccessToken()).rejects.toBeInstanceOf(ConnectSessionRequiredError);
  });

  it('keeps clearSession local-only and rejects a late renewal instead of resurrecting it', async () => {
    const storage = storageAdapter();
    seed(storage, credentials({ accessRemaining: -1 }));
    const gate = deferred<Response>();
    const started = deferred<void>();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => { started.resolve(); return await gate.promise; });
    const client = createSuperRareClient({ apiUrl, sessionStorage: storage, fetch });
    const pending = client.auth.getAccessToken();
    const rejected = expect(pending).rejects.toBeInstanceOf(ConnectSessionRequiredError);
    await started.promise;
    client.auth.clearSession();
    gate.resolve(response({ data: credentials({ sessionId: 'access_renewed', refreshToken: 'refresh_renewed' }) }));
    await rejected;
    expect(client.auth.getSession()).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('clears immediately on logout and awaits revocation of the in-flight renewal winner', async () => {
    const storage = storageAdapter();
    const original = credentials({ accessRemaining: -1 });
    seed(storage, original);
    const refreshGate = deferred<Response>();
    const refreshStarted = deferred<void>();
    const revokeGate = deferred<Response>();
    const revokeStarted = deferred<void>();
    const renewed = credentials({ sessionId: 'access_renewed', refreshToken: 'refresh_renewed' });
    const changes: unknown[] = [];
    const client = createSuperRareClient({ apiUrl, sessionStorage: storage, fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url.endsWith('/auth/refresh')) { refreshStarted.resolve(); return await refreshGate.promise; }
      expect(await request.json()).toEqual({ refreshToken: 'refresh_renewed' });
      revokeStarted.resolve();
      return await revokeGate.promise;
    } });
    const sibling = createSuperRareClient({ apiUrl, sessionStorage: storage });
    client.auth.onChange((session) => changes.push(session));
    const token = client.auth.getAccessToken();
    const rejected = expect(token).rejects.toBeInstanceOf(ConnectSessionRequiredError);
    await refreshStarted.promise;
    let logoutFinished = false;
    const logout = client.auth.logout().then(() => { logoutFinished = true; });
    expect(client.auth.getSession()).toBeUndefined();
    expect(sibling.auth.getSession()).toBeUndefined();
    expect(storage.getItem(storageKey)).toBe(JSON.stringify(original));
    refreshGate.resolve(response({ data: renewed }));
    await revokeStarted.promise;
    expect(storage.getItem(storageKey)).toBeNull();
    expect(logoutFinished).toBe(false);
    expect(changes).toEqual([undefined]);
    revokeGate.resolve(response({ data: { revoked: true } }));
    await logout;
    await rejected;
    expect(client.auth.getSession()).toBeUndefined();
  });

  it('completes persisted cleanup and revocation before rejecting a throwing logout observer', async () => {
    const storage = storageAdapter();
    seed(storage, credentials());
    const requests: unknown[] = [];
    const client = createSuperRareClient({
      apiUrl,
      sessionStorage: storage,
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requests.push(await request.json());
        return response({ data: { revoked: true } });
      },
    });
    client.auth.onChange(() => {
      throw new Error('observer failed');
    });

    await expect(client.auth.logout()).rejects.toThrow('observer failed');

    expect(storage.getItem(storageKey)).toBeNull();
    expect(requests).toEqual([{ refreshToken: 'refresh_original' }]);
  });

  it('waits for another tab to rotate before revoking its winner under the same Web Lock', async () => {
    const values = new Map<string, string>();
    const remoteStorage = storageAdapter(values);
    const localStorage = storageAdapter(values);
    const original = credentials({ accessRemaining: -1 });
    seed(remoteStorage, original);
    const gate = deferred<Response>();
    const started = deferred<void>();
    const renewed = credentials({ sessionId: 'access_renewed', refreshToken: 'refresh_renewed' });
    const revoked: unknown[] = [];
    let queue = Promise.resolve();
    vi.stubGlobal('navigator', { locks: { request: <T>(_name: string, operation: () => Promise<T>): Promise<T> => {
      const pending = queue.then(operation);
      queue = pending.then(() => undefined, () => undefined);
      return pending;
    } } });
    try {
      const remote = createSuperRareClient({ apiUrl, sessionStorage: remoteStorage, fetch: async () => {
        started.resolve();
        return await gate.promise;
      } });
      const local = createSuperRareClient({ apiUrl, sessionStorage: localStorage, fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        expect(request.url).toBe(`${apiUrl}/v1/connect/auth/logout`);
        revoked.push(await request.json());
        return response({ data: { revoked: true } });
      } });
      const token = remote.auth.getAccessToken().catch(() => undefined);
      await started.promise;
      const logout = local.auth.logout();
      expect(local.auth.getSession()).toBeUndefined();
      expect(localStorage.getItem(storageKey)).toBe(JSON.stringify(original));
      gate.resolve(response({ data: renewed }));
      await Promise.all([token, logout]);
      expect(revoked).toEqual([{ refreshToken: 'refresh_renewed' }]);
      expect(localStorage.getItem(storageKey)).toBeNull();
      expect(remote.auth.getSession()).toBeUndefined();
      expect(local.auth.getSession()).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps a newer cross-tab login when an older logout waits behind refresh', async () => {
    const values = new Map<string, string>();
    const loginStorage = storageAdapter(values);
    const logoutStorage = storageAdapter(values);
    seed(loginStorage, credentials({ accessRemaining: -1 }));
    const refreshGate = deferred<Response>();
    const refreshStarted = deferred<void>();
    const newer = credentials({ sessionId: 'access_new_login', refreshToken: 'refresh_new_login' });
    const renewed = credentials({ sessionId: 'access_rotated', refreshToken: 'refresh_rotated' });
    const revoked: unknown[] = [];
    let lockRequests = 0;
    let queue = Promise.resolve();
    vi.stubGlobal('navigator', {
      locks: {
        request: <T>(_name: string, operation: () => Promise<T>): Promise<T> => {
          lockRequests += 1;
          const pending = queue.then(operation);
          queue = pending.then(() => undefined, () => undefined);
          return pending;
        },
      },
    });
    try {
      const loginHarnessResult = loginHarness({
        storage: loginStorage,
        exchange: newer,
        fetchAuth: async (request) => {
          if (request.url.endsWith('/auth/refresh')) {
            refreshStarted.resolve();
            return await refreshGate.promise;
          }
          return response({ data: { revoked: true } });
        },
      });
      const logoutClient = createSuperRareClient({
        apiUrl,
        sessionStorage: logoutStorage,
        fetch: async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);
          revoked.push(await request.json());
          return response({ data: { revoked: true } });
        },
      });
      const token = loginHarnessResult.client.auth.getAccessToken().catch(() => undefined);
      await refreshStarted.promise;
      const logout = logoutClient.auth.logout();
      const login = loginHarnessResult.login();
      await vi.waitFor(() => expect(lockRequests).toBe(3));

      refreshGate.resolve(response({ data: renewed }));
      await Promise.all([token, logout, login]);

      expect(revoked).toEqual([{ refreshToken: 'refresh_rotated' }]);
      expect(storedCredentials(logoutStorage)).toEqual(newer);
      expect(loginHarnessResult.client.auth.getSession()).toEqual(newer.session);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(['unavailable', 'blocked'])('preserves the rotated credential when a concurrent login is %s', async (failure) => {
    const storage = storageAdapter();
    seed(storage, credentials({ accessRemaining: -1 }));
    const gate = deferred<Response>();
    const started = deferred<void>();
    const renewed = credentials({ sessionId: 'access_renewed', refreshToken: 'refresh_renewed' });
    const latest = credentials({ sessionId: 'access_latest', refreshToken: 'refresh_latest' });
    const refreshed: unknown[] = [];
    const popup: ConnectPopupWindow = { closed: false, close: () => {}, location: { replace: () => {} } };
    vi.stubGlobal('addEventListener', undefined);
    vi.stubGlobal('removeEventListener', undefined);
    try {
      const client = createSuperRareClient({
        apiUrl,
        sessionStorage: storage,
        popup: {
          open: () => failure === 'blocked' ? null : popup,
          messageEvents: failure === 'blocked' ? { subscribe: () => () => {} } : undefined,
        },
        fetch: async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);
          refreshed.push(await request.json());
          started.resolve();
          return refreshed.length === 1 ? await gate.promise : response({ data: latest });
        },
      });
      const pending = client.auth.getAccessToken();
      await started.promise;
      if (failure === 'blocked') await expect(client.auth.login()).rejects.toBeInstanceOf(ConnectPopupBlockedError);
      else await expect(client.auth.login()).rejects.toBeInstanceOf(Error);
      gate.resolve(response({ data: renewed }));
      await expect(pending).resolves.toBe('access_renewed');
      expect(client.auth.getSession()).toEqual(renewed.session);
      seed(storage, { ...renewed, session: { ...renewed.session, expiresAt: new Date(Date.now() - 1).toISOString() } });
      await expect(client.auth.getAccessToken()).resolves.toBe('access_latest');
      expect(refreshed).toEqual([{ refreshToken: 'refresh_original' }, { refreshToken: 'refresh_renewed' }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('preserves a concurrent renewal when the user cancels a login during intent creation', async () => {
    vi.useFakeTimers();
    const storage = storageAdapter();
    seed(storage, credentials({ accessRemaining: -1 }));
    const refreshGate = deferred<Response>();
    const refreshStarted = deferred<void>();
    const intentGate = deferred<Response>();
    const renewed = credentials({ sessionId: 'access_renewed', refreshToken: 'refresh_renewed' });
    const popup: ConnectPopupWindow = {
      closed: false,
      close: () => { popup.closed = true; },
      location: { replace: () => {} },
    };
    try {
      const client = createSuperRareClient({
        apiUrl,
        sessionStorage: storage,
        initiatingOrigin: 'https://app.test',
        popup: { open: () => popup, messageEvents: { subscribe: () => () => {} } },
        fetch: async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);
          if (request.url.endsWith('/auth/refresh')) {
            refreshStarted.resolve();
            return await refreshGate.promise;
          }
          return await intentGate.promise;
        },
      });
      const token = client.auth.getAccessToken();
      await refreshStarted.promise;
      const login = client.auth.login();
      popup.closed = true;
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(login).resolves.toEqual({ status: 'cancelled' });
      refreshGate.resolve(response({ data: renewed }));
      await expect(token).resolves.toBe('access_renewed');
      expect(storedCredentials(storage)).toEqual(renewed);
      intentGate.resolve(response({ data: {
        intentId: 'intent_login',
        url: 'https://connect.superrare.test/login?intentId=intent_login',
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      } }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows a pending popup login to commit after normal renewal changes the access credential', async () => {
    const storage = storageAdapter();
    seed(storage, credentials({ accessRemaining: -1 }));
    const gate = deferred<Response>();
    const started = deferred<void>();
    const renewalFinished = deferred<void>();
    const renewed = credentials({ sessionId: 'access_renewed', refreshToken: 'refresh_renewed' });
    const newer = credentials({ sessionId: 'access_new_login', refreshToken: 'refresh_new_login' });
    const { client, login } = loginHarness({
      storage,
      exchange: newer,
      beforeCallback: () => renewalFinished.promise,
      fetchAuth: async () => { started.resolve(); return await gate.promise; },
    });
    const token = client.auth.getAccessToken();
    await started.promise;
    const pendingLogin = login();
    gate.resolve(response({ data: renewed }));
    await expect(token).resolves.toBe('access_renewed');
    renewalFinished.resolve();
    await pendingLogin;
    expect(client.auth.getSession()).toEqual(newer.session);
    expect(storedCredentials(storage)).toEqual(newer);
    await expect(client.auth.getAccessToken()).resolves.toBe('access_new_login');
  });

  it.each([200, 401, 503])('preserves a newer login after an older renewal returns %i', async (status) => {
    const storage = storageAdapter();
    seed(storage, credentials({ accessRemaining: -1 }));
    const gate = deferred<Response>();
    const started = deferred<void>();
    const newer = credentials({ sessionId: 'access_new_login', refreshToken: 'refresh_new_login' });
    const { client, login } = loginHarness({ storage, exchange: newer, fetchAuth: async () => {
      started.resolve(); return await gate.promise;
    } });
    const pending = client.auth.getAccessToken();
    const observed = pending.then((token) => token, () => undefined);
    await started.promise;
    const loginPromise = login();
    gate.resolve(status === 200 ? response({ data: credentials({ sessionId: 'access_old_renewal', refreshToken: 'refresh_old_renewal' }) })
      : response({ error: 'renewal failed' }, status));
    await Promise.all([observed, loginPromise]);
    expect(client.auth.getSession()).toEqual(newer.session);
    expect(storedCredentials(storage)).toEqual(newer);
    await expect(client.auth.getAccessToken()).resolves.toBe('access_new_login');
  });

  it('does not clear a new login while an old logout waits for renewal and revocation', async () => {
    const storage = storageAdapter();
    seed(storage, credentials({ accessRemaining: -1 }));
    const gate = deferred<Response>();
    const started = deferred<void>();
    const newer = credentials({ sessionId: 'access_new_login', refreshToken: 'refresh_new_login' });
    const revoked: unknown[] = [];
    const { client, login } = loginHarness({ storage, exchange: newer, fetchAuth: async (request) => {
      if (request.url.endsWith('/auth/refresh')) { started.resolve(); return await gate.promise; }
      revoked.push(await request.json());
      return response({ data: { revoked: true } });
    } });
    const token = client.auth.getAccessToken().catch(() => undefined);
    await started.promise;
    const logout = client.auth.logout();
    const loginPromise = login();
    gate.resolve(response({ data: credentials({ sessionId: 'access_old_renewal', refreshToken: 'refresh_old_renewal' }) }));
    await Promise.all([token, loginPromise, logout]);
    expect(revoked).toEqual([{ refreshToken: 'refresh_old_renewal' }]);
    expect(client.auth.getSession()).toEqual(newer.session);
  });

  it.each([401, 503])('keeps local logout final when revocation returns %i', async (status) => {
    const storage = storageAdapter();
    seed(storage, credentials());
    const client = createSuperRareClient({ apiUrl, sessionStorage: storage, fetch: async () => response({ error: 'revocation failed' }, status) });
    const logout = client.auth.logout();
    expect(client.auth.getSession()).toBeUndefined();
    if (status === 401) await expect(logout).resolves.toBeUndefined();
    else await expect(logout).rejects.toMatchObject({ status: 503 });
    expect(client.auth.getSession()).toBeUndefined();
  });

  it.each(['disabled', 'blocked', 'write-blocked'])('retains and renews authenticated credentials with storage %s', async (mode) => {
    const blocked: ConnectSessionStorage = {
      getItem: () => {
        if (mode === 'write-blocked') return null;
        throw new Error('Storage blocked');
      },
      setItem: () => { throw new Error('Storage blocked'); },
      removeItem: () => { throw new Error('Storage blocked'); },
    };
    const original = credentials({ accessRemaining: 30_000 });
    const renewed = credentials({ sessionId: 'access_renewed', refreshToken: 'refresh_renewed' });
    const revoked: unknown[] = [];
    const { client, login } = loginHarness({ storage: mode === 'disabled' ? false : blocked, exchange: original, fetchAuth: async (request) => {
      if (request.url.endsWith('/auth/refresh')) return response({ data: renewed });
      revoked.push(await request.json());
      return response({ data: { revoked: true } });
    } });
    await login();
    expect(client.auth.getSession()).toEqual(original.session);
    await expect(client.auth.getAccessToken()).resolves.toBe('access_renewed');
    await client.auth.logout();
    expect(revoked).toEqual([{ refreshToken: 'refresh_renewed' }]);
    expect(client.auth.getSession()).toBeUndefined();
  });

  it('isolates API origins even when client instances use the same configured storage key', async () => {
    const storage = storageAdapter();
    const original = credentials();
    seed(storage, original);
    const other = createSuperRareClient({ apiUrl: 'https://other-api.test', sessionStorage: storage });
    expect(other.auth.getSession()).toBeUndefined();
    await expect(other.auth.getAccessToken()).rejects.toBeInstanceOf(ConnectSessionRequiredError);
    const sameOrigin = createSuperRareClient({ apiUrl: `${apiUrl}/`, sessionStorage: storage });
    await expect(sameOrigin.auth.getAccessToken()).resolves.toBe(original.session.sessionId);
    other.auth.clearSession();
    expect(sameOrigin.auth.getSession()).toEqual(original.session);
  });
});
