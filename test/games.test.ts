import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSuperRareClient, type ConnectPopupMessageEvent } from '../src/client.js';
import { GameConnectionError } from '../src/games-core.js';
import { SuperRareConnectApiError } from '../src/errors.js';
import type { ConnectPopupWindow } from '../src/popup-core.js';
import type { ConnectSessionStorage } from '../src/session-storage-core.js';

const appId = '20000000-0000-0000-0000-000000000001';
const groupId = '40000000-0000-0000-0000-000000000001';
const appOrigin = 'https://game.test';
const studioUrl = 'https://studio.test';
const appPath = `${studioUrl}/api/v1/credit-groups/${groupId}/apps/${appId}`;
const authorization = {
  appId, groupId, appOrigin, authorizationToken: 'scoped-authorization',
  expiresAt: '2030-01-01T00:00:00.000Z', address: '0xabc',
};
const consent = {
  appId, groupId, consentId: 'consent-1', consentToken: 'narrow-token', credits: 3,
  expiresAt: '2030-01-01T00:00:00.000Z',
};
const attempt = {
  idempotencyKey: 'confirmed-start-001', fingerprint: 'a'.repeat(64), expectedCredits: 3,
  clientSessionId: 'client-round-1', clientBuildId: 'build-1', metadata: { difficulty: 'hard' },
};

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing fixture at index ${index}.`);
  return value;
}

const sessionResponse = (creditUse = false): Response => Response.json({
  version: '1',
  session: { id: 'session-1', token: 'play-token', expiresAt: '2030-01-01T00:00:00.000Z' },
  game: { id: appId, slug: 'game', title: 'Game', buildId: null },
  player: { kind: 'wallet', id: '0xabc', handle: null, displayName: '0xabc', avatarUrl: null, chainId: 1 },
  defaultLeaderboard: { key: 'default', seasonKey: 'all-time' },
  ...(creditUse ? { creditUse: { id: 'use-1', status: 'ready', credits: 3, token: 'consent-token' } } : {}),
}, { status: 201 });

function consentResponse(): Response {
  const { consentId, ...fields } = consent;
  return Response.json({ version: '1', consent: { id: consentId, ...fields } }, { status: 201 });
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

function harness(options: {
  fetch?: typeof fetch;
  storage?: ConnectSessionStorage | false;
  throwOnUnsubscribe?: boolean;
} = {}) {
  const listeners = new Set<(event: ConnectPopupMessageEvent) => void>();
  const windows: ConnectPopupWindow[] = [];
  const urls: string[] = [];
  const unsubscribe = vi.fn();
  const fetchImplementation = vi.fn(options.fetch ?? (async () => sessionResponse(true)));
  const client = createSuperRareClient({
    studioUrl, initiatingOrigin: appOrigin, fetch: fetchImplementation,
    sessionStorage: options.storage ?? false,
    popup: {
      open(url) {
        urls.push(url);
        const popup: ConnectPopupWindow = {
          closed: false,
          close() { popup.closed = true; },
          location: { replace() {} },
        };
        windows.push(popup);
        return popup;
      },
      messageEvents: { subscribe(next) {
        listeners.add(next);
        return () => {
          listeners.delete(next);
          unsubscribe();
          if (options.throwOnUnsubscribe) throw new Error('Cleanup failed.');
        };
      } },
    },
  });
  const game = client.games.forGame({ appId, groupId });
  const message = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
    type: 'superrare-connect:game-authorization',
    state: new URL(at(urls, urls.length - 1)).searchParams.get('state'),
    ...authorization, ...fields,
  });
  const emit = (data = message(), event: Partial<ConnectPopupMessageEvent> = {}) => {
    const messageEvent = { origin: studioUrl, source: windows[windows.length - 1], data, ...event };
    listeners.forEach((listener) => listener(messageEvent));
  };
  const connect = async () => {
    const pending = game.connect();
    emit();
    return await pending;
  };
  return { client, game, urls, windows, message, emit, connect, unsubscribe, fetchImplementation };
}

async function connectionError(operation: Promise<unknown>, code: string): Promise<void> {
  await expect(operation).rejects.toBeInstanceOf(GameConnectionError);
  await expect(operation).rejects.toMatchObject({ code });
}

afterEach(() => { vi.useRealTimers(); });

describe('game connection', () => {
  it('connects without consenting or starting and does not expose credentials in its URL', async () => {
    const h = harness();
    const pending = h.game.connect();
    const url = new URL(at(h.urls, 0));
    expect(url.pathname).toBe('/connect/games/authorize');
    expect(url.searchParams.get('appId')).toBe(appId);
    expect(url.searchParams.get('groupId')).toBe(groupId);
    expect(url.searchParams.get('appOrigin')).toBe(appOrigin);
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{16,256}$/);
    expect(url.search).not.toContain('token');
    h.emit();
    await expect(pending).resolves.toEqual(authorization);
    expect(h.fetchImplementation).not.toHaveBeenCalled();
    expect(at(h.windows, 0).closed).toBe(true);
    expect(h.unsubscribe).toHaveBeenCalledOnce();
  });

  it.each([
    ['source', { source: {} }],
    ['origin', { origin: 'https://evil.test' }],
  ] as const)('ignores unrelated %s messages instead of trusting their token', async (_name, event) => {
    const h = harness();
    const pending = h.game.connect();
    h.emit(h.message({ authorizationToken: 'attacker-token' }), event);
    h.emit();
    await expect(pending).resolves.toEqual(authorization);
    expect(h.fetchImplementation).not.toHaveBeenCalled();
  });

  it.each([
    ['state', { state: 'unrelated-state' }],
    ['app', { appId: 'other-app' }],
    ['group', { groupId: 'other-group' }],
    ['appOrigin', { appOrigin: 'https://evil.test' }],
  ] as const)('does not accept authorization for a different %s', async (_name, fields) => {
    const h = harness();
    const pending = h.game.connect();
    h.emit(h.message({ ...fields, authorizationToken: 'attacker-token' }));
    h.emit();
    await expect(pending).resolves.toEqual(authorization);
    expect(h.fetchImplementation).not.toHaveBeenCalled();
  });

  it('rejects a valid-bound message without a source', async () => {
    const h = harness();
    const pending = h.game.connect();
    h.emit(h.message(), { source: undefined });
    await connectionError(pending, 'invalid_message');
    expect(at(h.windows, 0).closed).toBe(true);
  });

  it('rejects explicit cancellation without accounting requests', async () => {
    const h = harness();
    const pending = h.game.connect();
    h.emit({ type: 'superrare-connect:game-authorization-cancelled',
      state: h.message().state, appId, groupId });
    await connectionError(pending, 'cancelled');
    expect(h.fetchImplementation).not.toHaveBeenCalled();
    expect(h.unsubscribe).toHaveBeenCalledOnce();
    expect(at(h.windows, 0).closed).toBe(true);
  });

  it('settles when the connection window closes without a message', async () => {
    vi.useFakeTimers();
    const h = harness();
    const pending = h.game.connect();
    const rejected = connectionError(pending, 'cancelled');
    at(h.windows, 0).closed = true;
    await vi.advanceTimersByTimeAsync(2_000);
    await rejected;
    expect(h.fetchImplementation).not.toHaveBeenCalled();
    expect(h.unsubscribe).toHaveBeenCalledOnce();
  });

  it('expires an unanswered connection and cleans up its window', async () => {
    vi.useFakeTimers();
    const h = harness();
    const pending = h.game.connect();
    const rejected = connectionError(pending, 'expired');
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 2_000);
    await rejected;
    expect(at(h.windows, 0).closed).toBe(true);
    expect(h.unsubscribe).toHaveBeenCalledOnce();
    expect(h.fetchImplementation).not.toHaveBeenCalled();
  });

  it('rejects an already-expired authorization', async () => {
    const h = harness();
    const pending = h.game.connect();
    h.emit(h.message({ expiresAt: '2000-01-01T00:00:00.000Z' }));
    await connectionError(pending, 'expired');
    expect(h.fetchImplementation).not.toHaveBeenCalled();
  });

  it.each([
    { authorizationToken: '' }, { authorizationToken: undefined }, { address: undefined },
    { expiresAt: 'not-a-date' }, { expiresAt: undefined },
  ])('rejects incomplete or malformed authorization without caching it: %j', async (fields) => {
    const h = harness();
    const pending = h.game.connect();
    h.emit(h.message(fields));
    await connectionError(pending, 'invalid_message');
    await connectionError(h.game.requestConsent(attempt), 'authorization_required');
    expect(h.fetchImplementation).not.toHaveBeenCalled();
    expect(at(h.windows, 0).closed).toBe(true);
  });

  it('reuses valid scoped authorization but requires explicit reconnect after expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const h = harness();
    const pending = h.game.connect();
    const expiresAt = '2026-01-01T00:01:00.000Z';
    h.emit(h.message({ expiresAt }));
    await pending;
    await expect(h.game.connect()).resolves.toMatchObject({ expiresAt });
    expect(h.urls).toHaveLength(1);
    vi.setSystemTime(new Date(expiresAt));
    await connectionError(h.game.requestConsent(attempt), 'authorization_required');
    expect(h.fetchImplementation).not.toHaveBeenCalled();
    expect(h.urls).toHaveLength(1);
    const renewed = h.game.connect();
    expect(h.urls).toHaveLength(2);
    h.emit();
    await expect(renewed).resolves.toEqual(authorization);
  });

  it('restores valid game authorization from storage without opening a popup', async () => {
    const storage = memoryStorage();
    const initial = harness({ storage });
    await initial.connect();

    const reloaded = harness({ storage });
    expect(reloaded.game.getAuthorization()).toEqual(authorization);
    await expect(reloaded.game.connect()).resolves.toEqual(authorization);
    expect(reloaded.urls).toEqual([]);
    expect(reloaded.fetchImplementation).not.toHaveBeenCalled();
    expect(reloaded.client.games.forGame({
      appId: '20000000-0000-0000-0000-000000000002',
      groupId,
    }).getAuthorization()).toBeUndefined();
  });

  it('rejects persisted authorization bound to another app origin', () => {
    const storage = memoryStorage();
    const key = `superrare.connect.game-authorization:${encodeURIComponent(
      JSON.stringify([studioUrl, appId, groupId, appOrigin]),
    )}`;
    storage.values.set(key, JSON.stringify({
      ...authorization,
      appOrigin: 'https://other.game.test',
    }));

    const h = harness({ storage });
    expect(h.game.getAuthorization()).toBeUndefined();
    expect(storage.values.has(key)).toBe(false);
  });

  it('drops expired persisted authorization and renews only on explicit connect', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const storage = memoryStorage();
    const initial = harness({ storage });
    const expiresAt = '2026-01-01T00:01:00.000Z';
    const connected = initial.game.connect();
    initial.emit(initial.message({ expiresAt }));
    await connected;

    vi.setSystemTime(new Date(expiresAt));
    const reloaded = harness({ storage });
    expect(reloaded.game.getAuthorization()).toBeUndefined();
    expect(reloaded.urls).toEqual([]);
    const renewed = reloaded.game.connect();
    expect(reloaded.urls).toHaveLength(1);
    reloaded.emit();
    await expect(renewed).resolves.toEqual(authorization);
  });

  it('keeps renewed authorization when an older request returns unauthorized', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    let resolveConsentResponse: ((response: Response) => void) | undefined;
    const h = harness({
      storage: memoryStorage(),
      fetch: () => new Promise<Response>((resolve) => { resolveConsentResponse = resolve; }),
    });
    const initial = h.game.connect();
    h.emit(h.message({ authorizationToken: 'expired-token', expiresAt: '2026-01-01T00:01:00.000Z' }));
    await initial;

    const oldConsentRequest = h.game.requestConsent(attempt);
    vi.setSystemTime(new Date('2026-01-01T00:01:00.000Z'));
    const renewal = h.game.connect();
    h.emit(h.message({ authorizationToken: 'renewed-token' }));
    await renewal;
    if (resolveConsentResponse === undefined) throw new Error('Consent fetch did not start.');
    resolveConsentResponse(Response.json({
      error: { code: 'GAME_AUTHORIZATION_REQUIRED', message: 'Expired authorization.' },
    }, { status: 401 }));
    await expect(oldConsentRequest).rejects.toMatchObject({ status: 401 });
    expect(h.game.getAuthorization()).toMatchObject({ authorizationToken: 'renewed-token' });
  });

  it.each(['clearSession', 'logout'] as const)(
    'opens a fresh game authorization after pending connection %s',
    async (replacement) => {
      const h = harness();
      const stale = h.game.connect();
      if (replacement === 'clearSession') {
        h.client.auth.clearSession();
      } else {
        await h.client.auth.logout();
      }

      const current = h.game.connect();
      expect(h.urls).toHaveLength(2);
      at(h.windows, 0).closed = true;
      await connectionError(stale, 'cancelled');

      const shared = h.game.connect();
      expect(h.urls).toHaveLength(2);
      h.emit();
      await expect(current).resolves.toEqual(authorization);
      await expect(shared).resolves.toEqual(authorization);
    },
  );

  it('shares valid authorization across instances for the same scope, not another app', async () => {
    const h = harness();
    await h.connect();
    const sameGame = h.client.games.forGame({ appId, groupId });
    await expect(sameGame.connect()).resolves.toEqual(authorization);
    const otherGame = h.client.games.forGame({ appId: '20000000-0000-0000-0000-000000000002', groupId });
    await connectionError(otherGame.requestConsent(attempt), 'authorization_required');
    expect(h.urls).toHaveLength(1);
    expect(h.fetchImplementation).not.toHaveBeenCalled();
  });

  it.each(['clearSession', 'logout'] as const)(
    'keeps game authorization independent from SuperRare session %s',
    async (replacement) => {
      const h = harness();
      await h.connect();
      if (replacement === 'clearSession') h.client.auth.clearSession();
      else await h.client.auth.logout();
      expect(h.game.getAuthorization()).toEqual(authorization);
      await expect(h.game.connect()).resolves.toEqual(authorization);
      expect(h.urls).toHaveLength(1);
    },
  );

  it.each(['success', 'cancelled'] as const)('settles %s even if unsubscribe throws', async (outcome) => {
    const h = harness({ throwOnUnsubscribe: true });
    const pending = h.game.connect();
    if (outcome === 'success') {
      h.emit();
      await expect(pending).resolves.toEqual(authorization);
    } else {
      h.emit({ type: 'superrare-connect:game-authorization-cancelled',
        state: h.message().state, appId, groupId });
      await connectionError(pending, 'cancelled');
    }
    expect(at(h.windows, 0).closed).toBe(true);
    expect(h.fetchImplementation).not.toHaveBeenCalled();
  });
});

describe('inline paid confirmation', () => {
  it('loads canonical terms without a connection, consent, or paid use', async () => {
    const requests: Request[] = [];
    const h = harness({ fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json({ version: '1', terms: { appId, groupId, appOrigin, credits: 7, title: 'Canonical Game' } });
    } });
    await expect(h.game.getTerms()).resolves.toEqual({ appId, groupId, appOrigin, credits: 7, title: 'Canonical Game' });
    expect(requests.map((request) => [request.method, request.url])).toEqual([['GET', `${appPath}/terms`]]);
    expect(h.urls).toEqual([]);
  });

  it('requires prior connection and never opens a popup from consent issuance', async () => {
    const h = harness();
    await connectionError(h.game.requestConsent(attempt), 'authorization_required');
    expect(h.urls).toEqual([]);
    expect(h.fetchImplementation).not.toHaveBeenCalled();
  });

  it('issues narrow consent only after explicit request and saves it before a use', async () => {
    const storage = memoryStorage();
    const requests: Array<{ request: Request; body: unknown }> = [];
    const h = harness({ storage, fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push({ request, body: await request.json() });
      const saved = [...storage.values.values()].map((value) => JSON.parse(value));
      expect(JSON.stringify(saved)).toContain(attempt.idempotencyKey);
      expect(JSON.stringify(saved)).toContain(attempt.fingerprint);
      expect(JSON.stringify(saved)).toContain('client-round-1');
      expect(JSON.stringify(saved)).toContain('"expectedCredits":3');
      if (request.url.endsWith('/consents')) {
        expect(JSON.stringify(saved)).not.toContain(consent.consentToken);
        return consentResponse();
      }
      expect(JSON.stringify(saved)).toContain(consent.consentToken);
      return sessionResponse(true);
    } });
    await h.connect();
    expect(h.fetchImplementation).not.toHaveBeenCalled();
    const result = await h.game.requestConsent(attempt);
    expect(result).toEqual({ consent, recovery: 'persistent' });
    expect(requests).toHaveLength(1);
    expect(at(requests, 0).request.url).toBe(`${appPath}/consents`);
    expect(at(requests, 0).request.headers.get('authorization')).toBe('GameAuthorization scoped-authorization');
    expect(at(requests, 0).body).toEqual({ idempotencyKey: attempt.idempotencyKey,
      fingerprint: attempt.fingerprint, expectedCredits: 3 });
    await expect(h.game.startWithConsent({ ...attempt, consent: result.consent }))
      .resolves.toMatchObject({ session: { id: 'session-1' }, creditUse: { credits: 3 } });
    expect(at(requests, 1).request.url).toBe(`${appPath}/uses`);
    expect(at(requests, 1).request.headers.get('authorization')).toBe('GameConsent narrow-token');
    expect(at(requests, 1).request.headers.get('idempotency-key')).toBe(attempt.idempotencyKey);
    expect(at(requests, 1).body).toEqual({ idempotencyKey: attempt.idempotencyKey,
      clientSessionId: attempt.clientSessionId, clientBuildId: attempt.clientBuildId, metadata: attempt.metadata });
    expect(h.urls).toHaveLength(1);
  });

  it.each([
    [409, 'CREDIT_GROUP_COST_CHANGED'], [401, 'GAME_AUTHORIZATION_REQUIRED'],
    [403, 'FORBIDDEN'], [503, 'SERVICE_UNAVAILABLE'],
  ] as const)('propagates issuance %s %s without starting or retrying', async (status, code) => {
    const h = harness({ storage: memoryStorage(), fetch: async () => Response.json({ error: { code, message: code } }, { status }) });
    await h.connect();
    const pending = h.game.requestConsent(attempt);
    await expect(pending).rejects.toBeInstanceOf(SuperRareConnectApiError);
    await expect(pending).rejects.toMatchObject({ status, code });
    expect(h.fetchImplementation).toHaveBeenCalledTimes(1);
    expect(h.urls).toHaveLength(1);
    if (status === 401) {
      await connectionError(h.game.requestConsent(attempt), 'authorization_required');
      expect(h.game.getAuthorization()).toBeUndefined();
      expect(h.fetchImplementation).toHaveBeenCalledTimes(1);
      const renewed = h.game.connect();
      expect(h.urls).toHaveLength(2);
      h.emit();
      await renewed;
    } else {
      await h.game.connect();
      expect(h.urls).toHaveLength(1);
    }
  });

  it('asks Studio to reject expired unused consent instead of returning a cached credential', async () => {
    let issuanceCount = 0;
    const h = harness({ fetch: async () => {
      issuanceCount += 1;
      if (issuanceCount === 1) return consentResponse();
      return Response.json({ error: { code: 'CREDIT_GROUP_CONSENT_EXPIRED', message: 'Unused consent expired' } }, { status: 409 });
    } });
    await h.connect();
    await h.game.requestConsent(attempt);
    await expect(h.game.requestConsent(attempt)).rejects.toMatchObject({
      status: 409, code: 'CREDIT_GROUP_CONSENT_EXPIRED',
    });
    expect(h.urls).toHaveLength(1);
  });

  it('recovers an uncertain consumed start even after consent and game authorization expire', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const paths: string[] = [];
    let paidRequests = 0;
    const h = harness({ storage: memoryStorage(), fetch: async (input, init) => {
      const request = new Request(input, init);
      paths.push(request.url);
      if (request.url.endsWith('/consents')) {
        const { consentId, ...fields } = consent;
        return Response.json({ version: '1', consent: {
          ...fields, id: consentId, expiresAt: '2026-01-01T00:02:00.000Z',
        } });
      }
      paidRequests += 1;
      if (paidRequests === 1) throw new Error('Lost committed start response.');
      return sessionResponse(true);
    } });
    const connecting = h.game.connect();
    h.emit(h.message({ expiresAt: '2026-01-01T00:15:00.000Z' }));
    await connecting;
    const issued = await h.game.requestConsent(attempt);
    await expect(h.game.startWithConsent({ ...attempt, consent: issued.consent })).rejects.toThrow('Lost committed start response.');
    vi.setSystemTime(new Date('2026-01-01T00:16:00.000Z'));
    await expect(h.game.recoverStart({ idempotencyKey: attempt.idempotencyKey }))
      .resolves.toMatchObject({ session: { id: 'session-1' } });
    expect(paths).toEqual([`${appPath}/consents`, `${appPath}/uses`, `${appPath}/uses`]);
    expect(h.urls).toHaveLength(1);
  });

  it.each(['disabled', 'blocked'] as const)('reports memory-only recovery when persistence is %s', async (mode) => {
    const storage: ConnectSessionStorage | false = mode === 'disabled' ? false : {
      getItem() { throw new Error('Storage blocked.'); },
      setItem() { throw new Error('Storage blocked.'); },
      removeItem() { throw new Error('Storage blocked.'); },
    };
    const paths: string[] = [];
    const h = harness({ storage, fetch: async (input, init) => {
      const request = new Request(input, init);
      paths.push(request.url);
      return request.url.endsWith('/consents') ? consentResponse() : sessionResponse(true);
    } });
    await h.connect();
    await expect(h.game.requestConsent(attempt)).resolves.toEqual({ consent, recovery: 'memory' });
    await expect(h.game.recoverStart({ idempotencyKey: attempt.idempotencyKey }))
      .resolves.toMatchObject({ session: { id: 'session-1' } });
    expect(paths).toEqual([`${appPath}/consents`, `${appPath}/uses`]);
    expect(h.urls).toHaveLength(1);
  });

  it('reports memory recovery if saving the issued consent fails after the attempt was persisted', async () => {
    const persistent = memoryStorage();
    const storage: ConnectSessionStorage = {
      getItem: persistent.getItem,
      removeItem: persistent.removeItem,
      setItem(key, value) {
        if (value.includes(consent.consentToken)) throw new Error('Storage quota exceeded.');
        persistent.setItem(key, value);
      },
    };
    const paths: string[] = [];
    const h = harness({ storage, fetch: async (input, init) => {
      const request = new Request(input, init);
      paths.push(request.url);
      return request.url.endsWith('/consents') ? consentResponse() : sessionResponse(true);
    } });
    await h.connect();
    await expect(h.game.requestConsent(attempt)).resolves.toEqual({ consent, recovery: 'memory' });
    expect([...persistent.values.values()].join()).not.toContain(consent.consentToken);
    await expect(h.game.recoverStart({ idempotencyKey: attempt.idempotencyKey }))
      .resolves.toMatchObject({ session: { id: 'session-1' } });
    expect(paths).toEqual([`${appPath}/consents`, `${appPath}/uses`]);
  });

  it('recovers lost issuance with the original confirmed cost and body, not newly loaded terms', async () => {
    const storage = memoryStorage();
    let originalIssuanceBody: unknown;
    const first = harness({ storage, fetch: async (input, init) => {
      originalIssuanceBody = await new Request(input, init).json();
      throw new Error('Lost issuance response.');
    } });
    await first.connect();
    await expect(first.game.requestConsent(attempt)).rejects.toThrow('Lost issuance response.');
    const requests: Array<{ request: Request; body: unknown }> = [];
    const reloaded = harness({ storage, fetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith('/terms')) {
        return Response.json({ version: '1', terms: { appId, groupId, appOrigin, credits: 9, title: 'Game' } });
      }
      requests.push({ request, body: await request.json() });
      return request.url.endsWith('/consents') ? consentResponse() : sessionResponse(true);
    } });
    await expect(reloaded.game.getTerms()).resolves.toMatchObject({ credits: 9 });
    expect(requests).toEqual([]);
    expect(reloaded.game.getAuthorization()).toEqual(authorization);
    await expect(reloaded.game.recoverStart({ idempotencyKey: attempt.idempotencyKey }))
      .resolves.toMatchObject({ session: { id: 'session-1' } });
    expect(reloaded.urls).toEqual([]);
    expect(requests.map(({ request }) => request.url)).toEqual([`${appPath}/consents`, `${appPath}/uses`]);
    expect(at(requests, 0).body).toEqual({ idempotencyKey: attempt.idempotencyKey,
      fingerprint: attempt.fingerprint, expectedCredits: 3 });
    expect(at(requests, 0).body).toEqual(originalIssuanceBody);
    expect(at(requests, 1).body).toEqual({ idempotencyKey: attempt.idempotencyKey,
      clientSessionId: attempt.clientSessionId, clientBuildId: attempt.clientBuildId, metadata: attempt.metadata });
    expect(reloaded.urls).toHaveLength(0);
  });

  it.each(['network', '503'] as const)('recovers a lost paid start (%s) after reload with the saved consent and original body', async (failure) => {
    const storage = memoryStorage();
    let originalBody: unknown;
    const first = harness({ storage, fetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith('/consents')) return consentResponse();
      originalBody = await request.json();
      if (failure === 'network') throw new Error('Lost paid-start response.');
      return Response.json({ error: { message: 'Uncertain start' } }, { status: 503 });
    } });
    await first.connect();
    const issued = await first.game.requestConsent(attempt);
    await expect(first.game.startWithConsent({ ...attempt, consent: issued.consent })).rejects.toThrow();
    const requests: Request[] = [];
    const reloaded = harness({ storage, fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      expect(await request.json()).toEqual(originalBody);
      expect(request.headers.get('authorization')).toBe('GameConsent narrow-token');
      expect(request.headers.get('idempotency-key')).toBe(attempt.idempotencyKey);
      return sessionResponse(true);
    } });
    await expect(reloaded.game.recoverStart({ idempotencyKey: attempt.idempotencyKey }))
      .resolves.toMatchObject({ session: { id: 'session-1' } });
    expect(requests.map((request) => request.url)).toEqual([`${appPath}/uses`]);
    expect(reloaded.urls).toEqual([]);
    await expect(reloaded.game.recoverStart({ idempotencyKey: attempt.idempotencyKey })).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });

  it.each([
    { fingerprint: 'b'.repeat(64) }, { expectedCredits: 4 },
    { clientSessionId: 'another-round' }, { clientBuildId: 'another-build' },
    { metadata: { difficulty: 'easy' } },
  ])('rejects changed attempt bindings before issuing or using another consent: %j', async (changed) => {
    const h = harness({ storage: memoryStorage(), fetch: async () => consentResponse() });
    await h.connect();
    await h.game.requestConsent(attempt);
    await connectionError(h.game.requestConsent({ ...attempt, ...changed }), 'attempt_mismatch');
    expect(h.fetchImplementation).toHaveBeenCalledTimes(1);
    expect(h.urls).toHaveLength(1);
  });

  it('rejects recovery that changes the saved start body', async () => {
    const h = harness({ storage: memoryStorage(), fetch: async () => consentResponse() });
    await h.connect();
    await h.game.requestConsent(attempt);
    await connectionError(h.game.recoverStart({ idempotencyKey: attempt.idempotencyKey,
      metadata: { difficulty: 'easy' } }), 'attempt_mismatch');
    expect(h.fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it('rejects a start that changes the saved confirmation body before spending', async () => {
    const h = harness({ storage: memoryStorage(), fetch: async () => consentResponse() });
    await h.connect();
    const issued = await h.game.requestConsent(attempt);
    await connectionError(h.game.startWithConsent({ ...attempt, consent: issued.consent,
      metadata: { difficulty: 'easy' } }), 'attempt_mismatch');
    expect(h.fetchImplementation).toHaveBeenCalledTimes(1);
    expect(h.urls).toHaveLength(1);
  });
});

describe('games namespace', () => {
  it('retries a free start using its original caller-owned key', async () => {
    let calls = 0;
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.url).toBe(`${studioUrl}/api/v1/games/${appId}/sessions`);
      expect(request.headers.get('idempotency-key')).toBe('free-start-key-001');
      expect(await request.json()).toEqual({ idempotencyKey: 'free-start-key-001' });
      if (++calls === 1) throw new Error('Lost response.');
      return sessionResponse();
    });
    const game = createSuperRareClient({ studioUrl, fetch: fetchImplementation }).games.forGame({ appId });
    await expect(game.start({ idempotencyKey: 'free-start-key-001' })).rejects.toThrow('Lost response.');
    await expect(game.start({ idempotencyKey: 'free-start-key-001' })).resolves.toMatchObject({ session: { id: 'session-1' } });
  });

  it('keeps client-asserted scores distinct from server-validated runs', async () => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.headers.get('authorization')).toBe('PlaySession play-token');
      if (request.url.endsWith('/leaderboards/default/scores')) {
        return Response.json({ version: '1', scoreId: 'score-1', score: '42', idempotentReplay: false }, { status: 201 });
      }
      return Response.json({ version: '1', run: {
        runId: 'run-1', eventId: 'event-1', engine: 'custom', engineVersion: 'custom-v1', configDigest: 'a'.repeat(64),
        config: {}, attemptNumber: 1, startedAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-01T00:10:00Z',
        idempotentReplay: false, state: {}, webSocketUrl: 'wss://studio.test/run',
      } }, { status: 201 });
    });
    const game = createSuperRareClient({ studioUrl, fetch: fetchImplementation }).games.forGame({ appId });
    await expect(game.submitClientAssertedScore({ sessionToken: 'play-token', score: 42, idempotencyKey: 'score-key-001' }))
      .resolves.toMatchObject({ score: '42' });
    await expect(game.startServerValidatedRun({ sessionToken: 'play-token', eventId: 'event-1', idempotencyKey: 'run-key-001' }))
      .resolves.toMatchObject({ run: { runId: 'run-1' } });
  });
});
