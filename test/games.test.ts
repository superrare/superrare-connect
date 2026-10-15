import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSuperRareClient, ConnectSessionRequiredError, type SuperRareGameClient } from '../src/client.js';
import { GameConnectionError } from '../src/games-core.js';
import { SuperRareConnectApiError } from '../src/errors.js';
import type { ConnectSessionStorage } from '../src/session-storage-core.js';

const appId = '20000000-0000-0000-0000-000000000001';
const groupId = '40000000-0000-0000-0000-000000000001';
const appOrigin = 'https://game.test';
const studioUrl = 'https://studio.test';
const appPath = `${studioUrl}/api/v1/credit-groups/${groupId}/apps/${appId}`;
const issuedAt = '2026-01-01T00:00:00.000Z';
const authorization = {
  appId, groupId, appOrigin, authorizationToken: 'scoped-authorization',
  expiresAt: '2026-01-01T00:10:00.000Z', address: '0xabc',
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
  authorizationFetch?: typeof fetch;
  storage?: ConnectSessionStorage | false;
  signedIn?: boolean;
} = {}) {
  const sessionKey = 'fixture-connect-session';
  const credentials = memoryStorage();
  if (options.signedIn !== false) credentials.setItem(sessionKey, JSON.stringify({
    session: { sessionId: 'fixture-access', userId: 'fixture-user', address: authorization.address,
      expiresAt: '2030-01-01T00:00:00.000Z' },
    refreshToken: 'fixture-refresh', refreshExpiresAt: '2030-01-01T00:00:00.000Z',
  }));
  const gameStorage = options.storage === undefined ? memoryStorage() : options.storage;
  // Fixture Connect credentials are isolated from game persistence failures.
  const storage: ConnectSessionStorage = {
    getItem(key) {
      if (key === sessionKey) return credentials.getItem(key);
      return gameStorage === false ? null : gameStorage.getItem(key);
    },
    setItem(key, value) {
      if (key === sessionKey) credentials.setItem(key, value);
      else {
        if (gameStorage === false) throw new Error('Game persistence disabled in fixture.');
        gameStorage.setItem(key, value);
      }
    },
    removeItem(key) {
      if (key === sessionKey) credentials.removeItem(key);
      else if (gameStorage !== false) gameStorage.removeItem(key);
    },
  };
  const urls: string[] = [];
  const open = vi.fn((url: string) => { urls.push(url); return null; });
  let nextAuthorization: unknown = authorization;
  const authorizationFetch = vi.fn(options.authorizationFetch ?? (async () =>
    Response.json({ version: '1', issuedAt, authorization: nextAuthorization }, { status: 201 })));
  const fetchImplementation = vi.fn(options.fetch ?? (async () => sessionResponse(true)));
  const client = createSuperRareClient({
    studioUrl, initiatingOrigin: appOrigin, sessionStorage: storage, sessionStorageKey: sessionKey,
    popup: { open },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === '/v1/connect/auth/logout') {
        return Response.json({ data: { revoked: true } });
      }
      return request.url === `${appPath}/authorizations`
        ? authorizationFetch(input, init) : fetchImplementation(input, init);
    },
  });
  const game = client.games.forGame({ appId, groupId });
  return {
    client, game, urls, open, authorizationFetch, fetchImplementation, credentials,
    connect: () => game.connect(),
    setAuthorization(fields: Record<string, unknown> = {}): void {
      nextAuthorization = { ...authorization, ...fields };
    },
  };
}

async function connectionError(operation: Promise<unknown>, code: string): Promise<void> {
  await expect(operation).rejects.toBeInstanceOf(GameConnectionError);
  await expect(operation).rejects.toMatchObject({ code });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('authoritative scoring reads', () => {
  const leaderboardEntry = {
    rank: 1, scoreId: '50000000-0000-4000-8000-000000000001', score: '9007199254740993',
    secondaryValue: null, trustLevel: 'server_verified', achievedAt: '2026-01-01T00:00:00.000Z',
    player: { kind: 'profile', id: 'profile-1', handle: 'champion', displayName: 'Champion', avatarUrl: null },
    isCurrentPlayer: false,
  };

  it('reads public verified rankings without login and preserves ties, identities, and large integer precision', async () => {
    const entries = [
      leaderboardEntry,
      { ...leaderboardEntry, scoreId: '50000000-0000-4000-8000-000000000002',
        player: { kind: 'wallet', id: '0xabc', handle: null, displayName: 'Wallet', avatarUrl: null, chainId: 1 } },
      { ...leaderboardEntry, rank: 3, scoreId: '50000000-0000-4000-8000-000000000003', score: '0',
        player: { kind: 'guest', id: null, handle: null, displayName: 'Guest', avatarUrl: null } },
    ];
    const h = harness({ signedIn: false, fetch: async (input, init) => {
      expect(new Request(input, init).headers.has('authorization')).toBe(false);
      return Response.json({ version: '1', entries });
    } });
    await expect(h.game.getServerLeaderboard()).resolves.toEqual(entries);
    expect(h.authorizationFetch).not.toHaveBeenCalled();
    expect(h.open).not.toHaveBeenCalled();
  });

  it('returns an empty public ranking when no scorer has completed a run', async () => {
    const h = harness({ signedIn: false, fetch: async () => Response.json({ version: '1', entries: [] }) });
    await expect(h.game.getServerLeaderboard()).resolves.toEqual([]);
  });

  it.each([
    { trustLevel: 'legacy_unverified' }, { trustLevel: 'client_asserted' }, { trustLevel: 'replay_verified' },
    { score: '-1' }, { score: '1e3' }, { score: ' 42' }, { score: '' }, { score: 42 },
    { score: '1.5' }, { score: '1.0' }, { score: '00' }, { score: '042' },
    { rank: 0 }, { rank: 1.5 }, { rank: 11 },
    { scoreId: 'not-a-run-uuid' }, { achievedAt: 'not-a-date' },
    { secondaryValue: '1' }, { isCurrentPlayer: true },
    { player: { ...leaderboardEntry.player, kind: 'unknown' } },
    { player: { ...leaderboardEntry.player, id: 1 } },
    { player: { ...leaderboardEntry.player, handle: undefined } },
    { player: { ...leaderboardEntry.player, displayName: null } },
    { player: { ...leaderboardEntry.player, avatarUrl: 42 } },
    { player: { ...leaderboardEntry.player, chainId: 1.5 } },
  ])('rejects malformed or non-authoritative leaderboard entries: %j', async (fields) => {
    const h = harness({ fetch: async () => Response.json({
      version: '1', entries: [{ ...leaderboardEntry, ...fields }],
    }) });
    await expect(h.game.getServerLeaderboard()).rejects.toThrow();
  });

  it.each([
    { version: '1', entries: Array.from({ length: 11 }, () => leaderboardEntry) },
    { version: '2', entries: [] },
    { version: '1' },
  ])('rejects oversized or malformed leaderboard responses: %j', async (body) => {
    const h = harness({ fetch: async () => Response.json(body) });
    await expect(h.game.getServerLeaderboard()).rejects.toThrow();
  });

  it('preserves unavailable public rankings as errors instead of an empty ranking', async () => {
    const h = harness({ fetch: async () => Response.json({
      error: { code: 'UNAVAILABLE', message: 'Scoring unavailable' },
    }, { status: 503 }) });
    await expect(h.game.getServerLeaderboard()).rejects.toMatchObject({ status: 503, code: 'UNAVAILABLE' });
  });

  it.each([
    { version: '1' },
    { version: '1', eventId: null },
    { version: '1', eventId: 'not-an-event-uuid' },
    { version: '2', eventId: appId },
    { version: '1', eventId: appId, unexpected: true },
  ])('rejects malformed active-event discovery: %j', async (body) => {
    const h = harness({ fetch: async () => Response.json(body) });
    await expect(h.game.getActiveScoringEvent()).rejects.toThrow();
  });

  it('preserves absence of an active event as a platform error', async () => {
    const h = harness({ fetch: async () => Response.json({
      error: { code: 'GAME_NOT_FOUND', message: 'No active scoring event for this deployment' },
    }, { status: 404 }) });
    await expect(h.game.getActiveScoringEvent()).rejects.toMatchObject({
      status: 404, code: 'GAME_NOT_FOUND',
    });
  });

  it('does not turn unavailable scoring into a zero score', async () => {
    const h = harness({ fetch: async () => Response.json({
      error: { code: 'UNAVAILABLE', message: 'Scoring unavailable' },
    }, { status: 503 }) });
    await expect(h.game.getServerTopScore()).rejects.toBeInstanceOf(SuperRareConnectApiError);
  });

  it('keeps no completed score distinct from a completed zero score', async () => {
    const missing = harness({ fetch: async () => Response.json({ version: '1', topScore: null }) });
    const zero = harness({ fetch: async () => Response.json({ version: '1', topScore: 0 }) });
    await expect(missing.game.getServerTopScore()).resolves.toBeNull();
    await expect(zero.game.getServerTopScore()).resolves.toBe(0);
  });

  it('normalizes PostgreSQL decimal digit scores without losing precision', async () => {
    const h = harness({ fetch: async () => Response.json({ version: '1', topScore: '9007199254740991' }) });
    await expect(h.game.getServerTopScore()).resolves.toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([
    -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '9007199254740992',
    '', ' 42', '42 ', '-1', '1.5', '1e3', '0x10', true, {},
  ])('rejects unsafe or malformed server scores: %j', async (topScore) => {
    const h = harness({ fetch: async () => Response.json({ version: '1', topScore }) });
    await expect(h.game.getServerTopScore()).rejects.toThrow();
  });

  it.each([{ version: '1' }, { version: '2', topScore: 0 }])('rejects incomplete score responses: %j', async (body) => {
    const h = harness({ fetch: async () => Response.json(body) });
    await expect(h.game.getServerTopScore()).rejects.toThrow();
  });
});

describe('game connection', () => {
  it('exchanges signed-in access without opening UI, consenting, starting, or modifying pending attempts', async () => {
    const storage = memoryStorage();
    storage.setItem('pending-purchase', 'unchanged-purchase');
    const h = harness({ storage });
    await expect(h.game.connect()).resolves.toEqual(authorization);
    expect(h.open).not.toHaveBeenCalled();
    expect(h.fetchImplementation).not.toHaveBeenCalled();
    expect(storage.getItem('pending-purchase')).toBe('unchanged-purchase');
    expect(h.game.getAuthorization()).toEqual(authorization);
  });

  it('requires signed-in access without implicitly opening login or making an authorization request', async () => {
    const h = harness({ signedIn: false });
    await expect(h.game.connect()).rejects.toBeInstanceOf(ConnectSessionRequiredError);
    expect(h.authorizationFetch).not.toHaveBeenCalled();
    expect(h.fetchImplementation).not.toHaveBeenCalled();
    expect(h.open).not.toHaveBeenCalled();
  });

  it('renews near-expiry Connect access before exchanging it without exposing refresh credentials to Studio', async () => {
    const h = harness({
      fetch: async (input, init) => {
        const request = new Request(input, init);
        expect(new URL(request.url).pathname).toBe('/v1/connect/auth/refresh');
        return Response.json({ data: {
          session: { sessionId: 'fixture-renewed-access', userId: 'fixture-user', address: authorization.address,
            expiresAt: '2026-01-01T01:00:00.000Z' },
          refreshToken: 'fixture-rotated-refresh', refreshExpiresAt: '2030-01-01T00:00:00.000Z',
        } });
      },
      authorizationFetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.headers.get('authorization') !== 'ConnectSession fixture-renewed-access') {
          return Response.json({ error: { code: 'CONNECT_UNAUTHORIZED', message: 'Current access required.' } }, { status: 401 });
        }
        return Response.json({ version: '1', issuedAt, authorization }, { status: 201 });
      },
    });
    h.credentials.setItem('fixture-connect-session', JSON.stringify({
      session: { sessionId: 'fixture-expiring-access', userId: 'fixture-user', address: authorization.address,
        expiresAt: '2026-01-01T00:00:45.000Z' },
      refreshToken: 'fixture-original-refresh', refreshExpiresAt: '2030-01-01T00:00:00.000Z',
    }));
    await expect(h.game.connect()).resolves.toEqual(authorization);
  });

  it('rejects a configured origin that differs from the actual browser before exposing access to Studio', async () => {
    vi.stubGlobal('location', { origin: 'https://other-browser.test' });
    const h = harness();
    await connectionError(h.game.connect(), 'invalid_origin');
    expect(h.authorizationFetch).not.toHaveBeenCalled();
  });

  it.each([
    { appId: 'other-app' }, { groupId: 'other-group' }, { appOrigin: 'https://evil.test' },
    { address: '0xdef' }, { authorizationToken: '' }, { authorizationToken: undefined },
    { expiresAt: 'not-a-date' }, { expiresAt: undefined },
    { expiresAt: '2026-01-01T00:15:00.001Z' },
  ])('rejects invalid authorization bindings before storing or using them: %j', async (fields) => {
    const storage = memoryStorage();
    const h = harness({ storage });
    h.setAuthorization(fields);
    await connectionError(h.game.connect(), 'invalid_authorization');
    expect(h.game.getAuthorization()).toBeUndefined();
    expect([...storage.values.keys()].some((key) => key.startsWith('superrare.connect.game-authorization:'))).toBe(false);
    await connectionError(h.game.requestConsent(attempt), 'authorization_required');
  });

  it.each([undefined, 1, '2'])('rejects unsupported response versions: %j', async (version) => {
    const h = harness({ authorizationFetch: async () => Response.json({ version, issuedAt, authorization }) });
    await connectionError(h.game.connect(), 'invalid_authorization');
    expect(h.game.getAuthorization()).toBeUndefined();
  });

  it.each([88, 30_000, -30_000])('accepts a server-bounded authorization with browser clock skew of %sms', async (skew) => {
    vi.setSystemTime(Date.parse(issuedAt) - skew);
    const h = harness();
    h.setAuthorization({ expiresAt: '2026-01-01T00:15:00.000Z' });
    await expect(h.game.connect()).resolves.toMatchObject({ expiresAt: '2026-01-01T00:15:00.000Z' });
    expect(h.game.getAuthorization()?.expiresAt).toBe('2026-01-01T00:15:00.000Z');
  });

  it('rejects a lifetime exceeding the server cap even when a fast browser clock would allow it', async () => {
    vi.setSystemTime(Date.parse(issuedAt) + 30_000);
    const h = harness();
    h.setAuthorization({ expiresAt: '2026-01-01T00:15:00.001Z' });
    await connectionError(h.game.connect(), 'invalid_authorization');
    expect(h.game.getAuthorization()).toBeUndefined();
  });

  it.each([undefined, '', 'not-a-date', '2026-01-01T00:10:00.000Z', '2026-01-01T00:10:00.001Z'])(
    'rejects missing, malformed, or nonpositive server issuance intervals: %j', async (responseIssuedAt) => {
      const h = harness({ authorizationFetch: async () => Response.json({
        version: '1', issuedAt: responseIssuedAt, authorization,
      }) });
      await connectionError(h.game.connect(), 'invalid_authorization');
      expect(h.game.getAuthorization()).toBeUndefined();
    },
  );

  it('rejects already-expired authorization and authorization beyond Connect access expiry', async () => {
    const h = harness();
    h.setAuthorization({ expiresAt: '2026-01-01T00:00:00.000Z' });
    await connectionError(h.game.connect(), 'expired');
    h.credentials.setItem('fixture-connect-session', JSON.stringify({
      session: { sessionId: 'fixture-short-access', userId: 'fixture-user', address: authorization.address,
        expiresAt: '2026-01-01T00:05:00.000Z' },
      refreshToken: 'fixture-short-refresh', refreshExpiresAt: '2030-01-01T00:00:00.000Z',
    }));
    h.setAuthorization();
    await connectionError(h.game.connect(), 'invalid_authorization');
    expect(h.game.getAuthorization()).toBeUndefined();
  });

  it.each([[401, 'CONNECT_UNAUTHORIZED'], [403, 'CREDIT_GROUP_APP_NOT_APPROVED'], [503, 'CONNECT_UNAVAILABLE']] as const)(
    'propagates Studio %s %s without retrying or opening UI', async (status, code) => {
      const h = harness({ authorizationFetch: async () => Response.json({ error: { code, message: code } }, { status }) });
      await expect(h.game.connect()).rejects.toMatchObject({ status, code, path: `/api/v1/credit-groups/${groupId}/apps/${appId}/authorizations` });
      expect(h.authorizationFetch).toHaveBeenCalledOnce();
      expect(h.game.getAuthorization()).toBeUndefined();
      expect(h.open).not.toHaveBeenCalled();
    },
  );

  it('shares an in-flight exchange and clears failed requests so an explicit retry can succeed', async () => {
    let resolveResponse: (response: Response) => void = () => { throw new Error('Request not started.'); };
    const h = harness({ authorizationFetch: () => new Promise<Response>((resolve) => { resolveResponse = resolve; }) });
    const first = h.game.connect();
    const second = h.client.games.forGame({ appId, groupId }).connect();
    const firstFailure = expect(first).rejects.toMatchObject({ status: 503 });
    const secondFailure = expect(second).rejects.toMatchObject({ status: 503 });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.authorizationFetch).toHaveBeenCalledOnce();
    resolveResponse(Response.json({ error: 'Unavailable.' }, { status: 503 }));
    await Promise.all([firstFailure, secondFailure]);
    const renewed = h.game.connect();
    await vi.advanceTimersByTimeAsync(0);
    resolveResponse(Response.json({ version: '1', issuedAt, authorization }));
    await expect(renewed).resolves.toEqual(authorization);
  });

  it('restores and reuses scoped authorization while signed out without another exchange', async () => {
    const storage = memoryStorage();
    const initial = harness({ storage });
    await initial.connect();
    const reloaded = harness({ storage, signedIn: false });
    expect(reloaded.game.getAuthorization()).toEqual(authorization);
    await expect(reloaded.game.connect()).resolves.toEqual(authorization);
    expect(reloaded.authorizationFetch).not.toHaveBeenCalled();
    expect(reloaded.client.games.forGame({ appId: 'other-app', groupId }).getAuthorization()).toBeUndefined();
  });

  it.each([true, false])('does not reuse another signed-in wallet’s authorization (persistent=%s)', async (persistent) => {
    const storage = memoryStorage();
    const h = harness({ storage: persistent ? storage : false, fetch: async () => consentResponse() });
    await h.connect();
    await h.game.requestConsent(attempt);
    const savedAttempts = new Map(storage.values);
    h.credentials.setItem('fixture-connect-session', JSON.stringify({
      session: { sessionId: 'fixture-wallet-b-access', userId: 'fixture-wallet-b-user', address: '0xdef',
        expiresAt: '2030-01-01T00:00:00.000Z' },
      refreshToken: 'fixture-wallet-b-refresh', refreshExpiresAt: '2030-01-01T00:00:00.000Z',
    }));
    expect(h.game.getAuthorization()).toBeUndefined();
    await connectionError(h.game.credits.getBalance(), 'authorization_required');
    expect(h.fetchImplementation).toHaveBeenCalledOnce();
    if (persistent) expect(storage.values).toEqual(savedAttempts);
    h.setAuthorization({ address: '0xdef', authorizationToken: 'wallet-b-game-authorization' });
    await expect(h.game.connect()).resolves.toMatchObject({ address: '0xdef' });
    expect(h.authorizationFetch).toHaveBeenCalledTimes(2);
    expect(h.open).not.toHaveBeenCalled();
  });

  it('rejects persisted authorization bound to another app origin', () => {
    const storage = memoryStorage();
    storage.setItem(`superrare.connect.game-authorization:${encodeURIComponent(JSON.stringify([studioUrl, appId, groupId, appOrigin]))}`,
      JSON.stringify({ ...authorization, appOrigin: 'https://other.game.test' }));
    expect(harness({ storage }).game.getAuthorization()).toBeUndefined();
  });

  it('renews expired authorization only on explicit connect', async () => {
    const storage = memoryStorage();
    const initial = harness({ storage });
    initial.setAuthorization({ expiresAt: '2026-01-01T00:01:00.000Z' });
    await initial.connect();
    vi.setSystemTime(new Date('2026-01-01T00:01:00.000Z'));
    const reloaded = harness({ storage });
    expect(reloaded.game.getAuthorization()).toBeUndefined();
    await connectionError(reloaded.game.requestConsent(attempt), 'authorization_required');
    expect(reloaded.authorizationFetch).not.toHaveBeenCalled();
    await expect(reloaded.game.connect()).resolves.toEqual(authorization);
  });

  it('keeps renewed authorization when an older consent request returns unauthorized', async () => {
    let resolveResponse: (response: Response) => void = () => { throw new Error('Request not started.'); };
    const storage = memoryStorage();
    const oldClient = harness({ storage, fetch: () => new Promise<Response>((resolve) => { resolveResponse = resolve; }) });
    oldClient.setAuthorization({ authorizationToken: 'expired-token', expiresAt: '2026-01-01T00:01:00.000Z' });
    await oldClient.connect();
    const pending = oldClient.game.requestConsent(attempt);
    vi.setSystemTime(new Date('2026-01-01T00:01:00.000Z'));
    const renewingClient = harness({ storage });
    renewingClient.setAuthorization({ authorizationToken: 'renewed-token' });
    await renewingClient.connect();
    resolveResponse(Response.json({ error: { code: 'GAME_AUTHORIZATION_REQUIRED', message: 'Rejected.' } }, { status: 401 }));
    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(oldClient.game.getAuthorization()).toMatchObject({ authorizationToken: 'renewed-token' });
    expect(harness({ storage }).game.getAuthorization()).toMatchObject({ authorizationToken: 'renewed-token' });
  });

  it.each(['consent', 'credits'] as const)('invalidates a rejected token in a peer without deleting a concurrent renewal: %s', async (operation) => {
    const storage = memoryStorage();
    const rejecting = harness({ storage, fetch: async () => Response.json({
      error: { code: 'GAME_AUTHORIZATION_REQUIRED', message: 'Rejected.' },
    }, { status: 401 }) });
    await rejecting.connect();
    const peer = harness({ storage });
    await expect(operation === 'consent' ? rejecting.game.requestConsent(attempt) : rejecting.game.credits.getBalance())
      .rejects.toMatchObject({ status: 401 });
    expect(peer.game.getAuthorization()).toBeUndefined();
    await connectionError(peer.game.requestConsent(attempt), 'authorization_required');
    peer.setAuthorization({ authorizationToken: 'renewed-token' });
    await expect(peer.game.connect()).resolves.toMatchObject({ authorizationToken: 'renewed-token' });
  });

  it('does not delete a renewal written during stale authorization cleanup', async () => {
    const persistent = memoryStorage();
    const renewed = { ...authorization, authorizationToken: 'renewed-token' };
    let interleaveRenewal = false;
    const storage: ConnectSessionStorage = {
      getItem: persistent.getItem,
      setItem(key, value) {
        if (interleaveRenewal && key.includes(':rejected:')) {
          interleaveRenewal = false;
          const authorizationKey = key.split(':rejected:')[0];
          if (authorizationKey === undefined) throw new Error('Missing authorization key.');
          persistent.setItem(authorizationKey, JSON.stringify(renewed));
        }
        persistent.setItem(key, value);
      },
      removeItem: persistent.removeItem,
    };
    let resolveResponse: (response: Response) => void = () => { throw new Error('Request not started.'); };
    const oldClient = harness({ storage, fetch: () => new Promise<Response>((resolve) => { resolveResponse = resolve; }) });
    await oldClient.connect();
    const pending = oldClient.game.requestConsent(attempt);
    interleaveRenewal = true;
    resolveResponse(Response.json({ error: 'Rejected.' }, { status: 401 }));
    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(oldClient.game.getAuthorization()).toEqual(renewed);
    expect(harness({ storage: persistent }).game.getAuthorization()).toEqual(renewed);
  });

  it.each(['connect', 'getAuthorization'] as const)('returns immutable cache snapshots through %s', async (source) => {
    const requests: Request[] = [];
    const h = harness({ fetch: async (input, init) => { requests.push(new Request(input, init)); return consentResponse(); } });
    const connected = await h.connect();
    const exposed = source === 'connect' ? connected : h.game.getAuthorization();
    if (exposed === undefined) throw new Error('Missing authorization.');
    exposed.authorizationToken = 'caller-mutated-token';
    await h.game.requestConsent(attempt);
    expect(at(requests, 0).headers.get('authorization')).toBe('GameAuthorization scoped-authorization');
  });

  it.each(['clearSession', 'logout'] as const)('rejects an authorization arriving after pending connection %s', async (replacement) => {
    let resolveResponse: (response: Response) => void = () => { throw new Error('Request not started.'); };
    const h = harness({ authorizationFetch: () => new Promise<Response>((resolve) => { resolveResponse = resolve; }) });
    const pending = h.game.connect();
    await vi.advanceTimersByTimeAsync(0);
    if (replacement === 'clearSession') h.client.auth.clearSession();
    else await h.client.auth.logout();
    resolveResponse(Response.json({ version: '1', issuedAt, authorization }));
    await connectionError(pending, 'authorization_required');
    expect(h.game.getAuthorization()).toBeUndefined();
    await expect(h.game.connect()).rejects.toBeInstanceOf(ConnectSessionRequiredError);
  });

  it.each(['clearSession', 'logout'] as const)('keeps saved game authorization independent from session %s', async (replacement) => {
    const h = harness();
    await h.connect();
    if (replacement === 'clearSession') h.client.auth.clearSession();
    else await h.client.auth.logout();
    await expect(h.game.connect()).resolves.toEqual(authorization);
    expect(h.authorizationFetch).toHaveBeenCalledOnce();
  });
});

describe('game credit purchases', () => {
  it('does not use a broad SuperRare session in place of game authorization for credits', async () => {
    const storage = memoryStorage();
    const session = { sessionId: 'broad-access-token', userId: 'user-1', address: authorization.address,
      expiresAt: authorization.expiresAt };
    storage.setItem('broad-only:https%3A%2F%2Frare-api.test', JSON.stringify({
      session, refreshToken: 'broad-refresh-token', refreshExpiresAt: authorization.expiresAt,
    }));
    const fetchImplementation = vi.fn();
    const open = vi.fn(() => null);
    const client = createSuperRareClient({
      apiUrl: 'https://rare-api.test', studioUrl, initiatingOrigin: appOrigin,
      sessionStorage: storage, sessionStorageKey: 'broad-only', fetch: fetchImplementation, popup: { open },
    });
    expect(client.auth.getSession()).toEqual(session);
    const game = client.games.forGame({ appId, groupId });
    await connectionError(game.credits.getBalance(), 'authorization_required');
    await connectionError(game.credits.createPurchase(), 'authorization_required');
    await connectionError(game.credits.getPurchase('purchase-1'), 'authorization_required');
    await connectionError(game.credits.claimPurchase({ purchaseId: 'purchase-1', transactionHash: `0x${'a'.repeat(64)}` }),
      'authorization_required');
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  const balance = {
    accountId: 'account-1', groupId, chainId: 11155111, address: authorization.address,
    balance: 5, reserved: 3, available: 2,
  };
  const purchase = {
    id: 'purchase-1', accountId: balance.accountId, paymentConfigId: 'config-1',
    chainId: balance.chainId, address: balance.address,
    treasuryAddress: '0x1111111111111111111111111111111111111111',
    usdcAddress: '0x2222222222222222222222222222222222222222',
    packPriceAtomic: '2500000', packCredits: 10, minBlock: '7000000',
    createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:00:00.000Z',
    transactionHash: null, creditedAt: null,
  };
  const transactionHash = `0x${'a'.repeat(64)}`;
  const operations: Array<[string, (game: SuperRareGameClient) => Promise<unknown>]> = [
    ['getBalance', (game) => game.credits.getBalance()],
    ['createPurchase', (game) => game.credits.createPurchase()],
    ['getPurchase', (game) => game.credits.getPurchase(purchase.id)],
    ['claimPurchase', (game) => game.credits.claimPurchase({ purchaseId: purchase.id, transactionHash })],
  ];

  it('quotes, recovers, and claims an authoritative purchase using scoped game authorization without SDK login', async () => {
    let claimed = false;
    const creditedPurchase = { ...purchase, transactionHash, creditedAt: '2026-01-01T00:01:00.000Z' };
    const creditedBalance = { ...balance, balance: 15, available: 12 };
    const h = harness({ fetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.headers.get('authorization') !== `GameAuthorization ${authorization.authorizationToken}`) {
        return Response.json({ error: 'Game authorization required.' }, { status: 401 });
      }
      if (request.url === `${appPath}/me` && request.method === 'GET') {
        return Response.json({ version: '1', wallet: { chainId: balance.chainId, address: balance.address },
          balance: claimed ? creditedBalance : balance });
      }
      if (request.url === `${appPath}/purchases` && request.method === 'POST') {
        return Response.json({ version: '1', purchase }, { status: 201 });
      }
      if (request.url === `${appPath}/purchases/${purchase.id}` && request.method === 'GET') {
        return Response.json({ version: '1', purchase: claimed ? creditedPurchase : purchase });
      }
      if (request.url === `${appPath}/purchases/${purchase.id}/claim` && request.method === 'POST') {
        if (JSON.stringify(await request.json()) !== JSON.stringify({ transactionHash })) {
          return Response.json({ error: 'Transaction hash required.' }, { status: 400 });
        }
        claimed = true;
        return Response.json({ version: '1', purchase: creditedPurchase, balance: creditedBalance });
      }
      return Response.json({ error: 'Unknown game-scoped credit operation.' }, { status: 404 });
    } });
    await h.connect();
    h.client.auth.clearSession();
    expect(h.client.auth.getSession()).toBeUndefined();
    await expect(h.game.credits.getBalance()).resolves.toEqual(balance);
    const quote = await h.game.credits.createPurchase();
    expect(quote).toEqual(purchase);
    await expect(h.game.credits.getPurchase(quote.id)).resolves.toEqual(purchase);
    await expect(h.game.credits.claimPurchase({ purchaseId: quote.id, transactionHash }))
      .resolves.toEqual({ purchase: creditedPurchase, balance: creditedBalance });
    await expect(h.game.credits.getPurchase(quote.id)).resolves.toEqual(creditedPurchase);
    await expect(h.game.credits.getBalance()).resolves.toEqual(creditedBalance);
    expect(h.open).not.toHaveBeenCalled();
  });

  it.each(operations)('requires explicit game connection before %s without fetching or opening a popup', async (_name, operation) => {
    const h = harness();
    await connectionError(operation(h.game), 'authorization_required');
    expect(h.fetchImplementation).not.toHaveBeenCalled();
    expect(h.urls).toEqual([]);
  });

  it.each(operations)('requires explicit renewal before %s after authorization expires', async (_name, operation) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const storage = memoryStorage();
    const h = harness({ storage });
    const pending = h.game.connect();
    const expiresAt = '2026-01-01T00:01:00.000Z';
    h.setAuthorization({ expiresAt });
    await pending;
    vi.setSystemTime(new Date(expiresAt));
    await connectionError(operation(h.game), 'authorization_required');
    expect(h.game.getAuthorization()).toBeUndefined();
    expect(h.fetchImplementation).not.toHaveBeenCalled();
    expect(h.open).not.toHaveBeenCalled();
    expect(harness({ storage }).game.getAuthorization()).toBeUndefined();
    const renewed = h.game.connect();
    expect(h.open).not.toHaveBeenCalled();
    h.setAuthorization();
    await expect(renewed).resolves.toEqual(authorization);
  });

  it.each(operations)('invalidates cached and persisted authorization when Studio rejects %s', async (_name, operation) => {
    const storage = memoryStorage();
    const h = harness({ storage, fetch: async () => Response.json({
      error: { code: 'GAME_AUTHORIZATION_REQUIRED', message: 'Authorization rejected.' },
    }, { status: 401 }) });
    await h.connect();
    const rejected = operation(h.game);
    await expect(rejected).rejects.toBeInstanceOf(SuperRareConnectApiError);
    await expect(rejected).rejects.toMatchObject({ status: 401, code: 'GAME_AUTHORIZATION_REQUIRED' });
    expect(h.game.getAuthorization()).toBeUndefined();
    expect(harness({ storage }).game.getAuthorization()).toBeUndefined();
    for (const [, nextOperation] of operations) {
      await connectionError(nextOperation(h.game), 'authorization_required');
    }
    expect(h.fetchImplementation).toHaveBeenCalledOnce();
    expect(h.open).not.toHaveBeenCalled();
    const renewed = h.game.connect();
    expect(h.open).not.toHaveBeenCalled();
    h.setAuthorization();
    await expect(renewed).resolves.toEqual(authorization);
  });

  it.each(['app', 'group', 'origin', 'Studio'] as const)(
    'does not reuse game authorization from a different %s for credit operations',
    async (scope) => {
      const storage = memoryStorage();
      const h = harness({ storage });
      await h.connect();
      const open = vi.fn(() => null);
      const otherClient = createSuperRareClient({
        studioUrl: scope === 'Studio' ? 'https://other-studio.test' : studioUrl,
        initiatingOrigin: scope === 'origin' ? 'https://other-game.test' : appOrigin,
        sessionStorage: storage, fetch: h.fetchImplementation, popup: { open },
      });
      const otherGame = otherClient.games.forGame({
        appId: scope === 'app' ? '20000000-0000-0000-0000-000000000002' : appId,
        groupId: scope === 'group' ? '40000000-0000-0000-0000-000000000002' : groupId,
      });
      for (const [, operation] of operations) {
        await connectionError(operation(otherGame), 'authorization_required');
      }
      expect(h.fetchImplementation).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(h.game.getAuthorization()).toEqual(authorization);
    },
  );
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
    expect(h.open).not.toHaveBeenCalled();
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
    expect(h.open).not.toHaveBeenCalled();
    if (status === 401) {
      await connectionError(h.game.requestConsent(attempt), 'authorization_required');
      expect(h.game.getAuthorization()).toBeUndefined();
      expect(h.fetchImplementation).toHaveBeenCalledTimes(1);
      const renewed = h.game.connect();
      expect(h.open).not.toHaveBeenCalled();
      h.setAuthorization();
      await renewed;
    } else {
      await h.game.connect();
      expect(h.open).not.toHaveBeenCalled();
    }
  });

  it.each(['expired', 'server-rejected'] as const)('checks saved %s consent with Studio before declaring the original attempt unused', async (mode) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    let issuanceCount = 0;
    const h = harness({ fetch: async (input, init) => {
      if (new Request(input, init).url.endsWith('/consents')) {
        issuanceCount += 1;
        if (issuanceCount === 1) {
          const { consentId, ...fields } = consent;
          return Response.json({ version: '1', consent: {
            ...fields, id: consentId, expiresAt: '2026-01-01T00:02:00.000Z',
          } });
        }
        return Response.json({ error: { code: 'CREDIT_GROUP_CONSENT_EXPIRED', message: 'Unused consent expired' } }, { status: 409 });
      }
      return Response.json({ error: { code: 'CREDIT_GROUP_PAID_CONSENT_REQUIRED', message: 'Paid consent required' } }, { status: 401 });
    } });
    await h.connect();
    await h.game.requestConsent(attempt);
    if (mode === 'expired') vi.setSystemTime(new Date('2026-01-01T00:03:00.000Z'));
    await expect(h.game.recoverStart({ idempotencyKey: attempt.idempotencyKey })).rejects.toMatchObject({
      status: 409, code: 'CREDIT_GROUP_CONSENT_EXPIRED',
    });
    expect(h.open).not.toHaveBeenCalled();
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
    h.setAuthorization({ expiresAt: '2026-01-01T00:15:00.000Z' });
    await connecting;
    const issued = await h.game.requestConsent(attempt);
    await expect(h.game.startWithConsent({ ...attempt, consent: issued.consent })).rejects.toThrow('Lost committed start response.');
    vi.setSystemTime(new Date('2026-01-01T00:16:00.000Z'));
    await expect(h.game.recoverStart({ idempotencyKey: attempt.idempotencyKey }))
      .resolves.toMatchObject({ session: { id: 'session-1' } });
    expect(paths).toEqual([`${appPath}/consents`, `${appPath}/uses`, `${appPath}/uses`]);
    expect(h.open).not.toHaveBeenCalled();
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
    expect(h.open).not.toHaveBeenCalled();
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
    expect(reloaded.open).not.toHaveBeenCalled();
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
    expect(h.open).not.toHaveBeenCalled();
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
    expect(h.open).not.toHaveBeenCalled();
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
