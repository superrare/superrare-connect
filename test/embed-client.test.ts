import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConnectEmbedUnavailableError,
  createSuperRareClient,
  type ConnectDisplay,
  type ConnectEmbedWindow,
  type ConnectIntent,
  type ConnectIntentStatus,
  type ConnectPopupMessageEvent,
} from '../src/index.js';

const intentId = 'embedded-intent-123';
const state = 'embedded-state-123';
const origin = 'https://connect.test';
const expiresAt = '2030-01-01T00:00:00.000Z';
const transfer = {
  chainId: 8453,
  to: '0x3333333333333333333333333333333333333333',
  currency: 'USDC',
  amount: '2500000',
} as const;

function harness(input: {
  display?: ConnectDisplay;
  onNavigate?: () => void;
  onSubscribe?: () => void;
  intentType?: 'login' | 'transfer';
} = {}) {
  const listeners = new Set<(event: ConnectPopupMessageEvent) => void>();
  const source = {};
  const urls: string[] = [];
  const requests: Request[] = [];
  const unavailable: ConnectEmbedUnavailableError[] = [];
  const settled: ConnectIntent[] = [];
  let status: ConnectIntentStatus = 'requires_user';
  const frame: ConnectEmbedWindow = {
    messageSource: source,
    closed: false,
    close() { frame.closed = true; },
    location: { replace(url) { urls.push(url); input.onNavigate?.(); } },
  };
  const popupOpen = vi.fn((_url: string, _target: string, _features: string) => null);
  const client = createSuperRareClient({
    apiUrl: 'https://api.test', studioUrl: 'https://studio.test', initiatingOrigin: 'https://game.test',
    createState: () => state, sessionStorage: false,
    ...(input.display === undefined ? {} : { display: input.display }),
    embed: {
      open: () => frame,
      messageEvents: { subscribe(listener) { input.onSubscribe?.(); listeners.add(listener); return () => { listeners.delete(listener); }; } },
      onUnavailable: (error) => { unavailable.push(error); },
    },
    popup: { open: popupOpen },
    onIntentSettled: (intent) => { settled.push(intent); },
    fetch: async (requestInput, init) => {
      const request = new Request(requestInput, init);
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path === '/v1/connect/auth/exchange') {
        return Response.json({ data: {
          session: { sessionId: 'embed-session', userId: 'user-123', address: '0xabc', expiresAt },
          refreshToken: 'embed-refresh', refreshExpiresAt: expiresAt,
        } });
      }
      if (path === '/v1/connect/users/me') return Response.json({ error: 'Profile unavailable.' }, { status: 503 });
      if (path === '/v1/connect/auth/claim') return Response.json({ error: 'Not completed.' }, { status: 409 });
      if (path.endsWith('/authorizations')) return Response.json({ version: '1', issuedAt: new Date(Date.now()).toISOString(), authorization: {
        appId: '20000000-0000-0000-0000-000000000001', groupId: '40000000-0000-0000-0000-000000000001',
        appOrigin: 'https://game.test', authorizationToken: 'game-only-token',
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), address: '0xabc',
      } }, { status: 201 });
      if (request.method === 'GET') {
        return Response.json({ data: { intentId, type: input.intentType ?? 'login', status, expiresAt, returnPath: '/' } });
      }
      return Response.json({ data: { intentId, url: `${origin}/action/${intentId}`, expiresAt } });
    },
  });
  const emit = (data: unknown, event: Partial<ConnectPopupMessageEvent> = {}): void => {
    listeners.forEach((listener) => listener({ origin, source, data, ...event }));
  };
  const callback = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
    type: 'superrare-connect:auth-callback', intentId, state, code: 'one-time-code', ...fields,
  });
  return {
    client, frame, source, urls, requests, unavailable, settled, popupOpen,
    emit, callback, setStatus(next: ConnectIntentStatus) { status = next; },
    navigated: async (): Promise<void> => { await vi.waitFor(() => { expect(urls).toHaveLength(1); }); },
  };
}

function requestedPaths(requests: Request[]): string[] {
  return requests.map((request) => new URL(request.url).pathname);
}

afterEach(() => { vi.useRealTimers(); });

describe('embedded hosted Connect lifecycle', () => {
  it.each(['new', 'prepared'] as const)('subscribes before %s login navigation and exchanges the matching frame callback without dismissing it', async (mode) => {
    vi.useFakeTimers();
    const h = harness({ onNavigate: () => h.emit(h.callback()) });
    if (mode === 'prepared') await h.client.auth.prepareLogin();
    await expect(h.client.auth.login()).resolves.toMatchObject({ status: 'authenticated', session: { sessionId: 'embed-session' } });
    expect(new URL(h.urls[0] ?? '').searchParams.get('display')).toBe('embed');
    expect(h.client.auth.getSession()?.sessionId).toBe('embed-session');
    expect(h.frame.closed).toBe(false);
    expect(h.popupOpen).not.toHaveBeenCalled();
  });

  it.each(['new login', 'prepared login', 'transfer'] as const)('preserves navigation failures and cleans up the failed %s surface', async (operation) => {
    vi.useFakeTimers();
    const failure = new Error('Merchant iframe navigation failed.');
    const h = harness({ intentType: operation === 'transfer' ? 'transfer' : 'login', onNavigate: () => { throw failure; } });
    if (operation === 'prepared login') await h.client.auth.prepareLogin();
    const pending = operation === 'transfer' ? h.client.actions.transfer(transfer) : h.client.auth.login();
    await expect(pending).rejects.toBe(failure);
    expect(h.frame.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.client.auth.getSession()).toBeUndefined();
    expect(h.settled).toEqual([]);
  });

  it.each(['login', 'transfer'] as const)('rejects a failed message subscription instead of leaving an unwatched %s frame', async (operation) => {
    vi.useFakeTimers();
    const failure = new Error('Merchant message subscription failed.');
    const h = harness({ intentType: operation, onSubscribe: () => { throw failure; } });
    const pending = operation === 'transfer' ? h.client.actions.transfer(transfer) : h.client.auth.login();
    await expect(pending).rejects.toBe(failure);
    expect(h.frame.closed).toBe(true);
    expect(h.client.auth.getSession()).toBeUndefined();
    expect(h.settled).toEqual([]);
  });

  it.each(['source', 'origin', 'intent'] as const)('ignores a callback with a foreign %s before accepting the real callback', async (mismatch) => {
    vi.useFakeTimers();
    const h = harness();
    const pending = h.client.auth.login();
    await h.navigated();
    h.emit(h.callback(mismatch === 'intent' ? { intentId: 'other-intent' } : {}),
      mismatch === 'source' ? { source: {} } : mismatch === 'origin' ? { origin: 'https://evil.test' } : {});
    await vi.advanceTimersByTimeAsync(0);
    expect(requestedPaths(h.requests)).not.toContain('/v1/connect/auth/exchange');
    h.emit(h.callback());
    await expect(pending).resolves.toMatchObject({ status: 'authenticated' });
  });

  it('rejects a matching iframe callback with the wrong state before exchanging a code', async () => {
    vi.useFakeTimers();
    const h = harness();
    const pending = h.client.auth.login();
    const rejection = expect(pending).rejects.toMatchObject({ name: 'ConnectAuthPendingError', code: 'state_mismatch' });
    await h.navigated();
    h.emit(h.callback({ state: 'other-state' }));
    await rejection;
    expect(requestedPaths(h.requests)).not.toContain('/v1/connect/auth/exchange');
  });

  it('rejects unavailable embedded login and notifies the merchant without opening a fallback popup', async () => {
    vi.useFakeTimers();
    const h = harness();
    const pending = h.client.auth.login();
    const rejection = expect(pending).rejects.toBeInstanceOf(ConnectEmbedUnavailableError);
    await h.navigated();
    h.emit({ type: 'superrare-connect:embed-unavailable', intentId });
    await rejection;
    expect(h.unavailable).toMatchObject([{ code: 'embed_unavailable', intentId }]);
    expect(h.popupOpen).not.toHaveBeenCalled();
    expect(h.frame.closed).toBe(false);
    expect(h.client.auth.getSession()).toBeUndefined();
  });

  it('reconciles cancellation against the API instead of trusting a terminal iframe status', async () => {
    vi.useFakeTimers();
    const h = harness();
    const pending = h.client.auth.login();
    await h.navigated();
    h.emit({ type: 'superrare-connect:intent-status', intentId, status: 'cancelled' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.client.auth.getSession()).toBeUndefined();
    h.setStatus('cancelled');
    h.emit({ type: 'superrare-connect:intent-status', intentId, status: 'cancelled' });
    await expect(pending).resolves.toEqual({ status: 'cancelled' });
    expect(h.frame.closed).toBe(false);
    expect(requestedPaths(h.requests).filter((path) => path.endsWith(intentId))).toHaveLength(2);
  });

  it('settles an explicitly dismissed frame as cancelled after checking for a completed login', async () => {
    vi.useFakeTimers();
    const h = harness();
    const pending = h.client.auth.login();
    await h.navigated();
    h.frame.close();
    await vi.advanceTimersByTimeAsync(2000);
    await expect(pending).resolves.toEqual({ status: 'cancelled' });
    expect(requestedPaths(h.requests)).toContain('/v1/connect/auth/claim');
    expect(h.popupOpen).not.toHaveBeenCalled();
  });

  it('holds the frame blank until transfer beforeOpen persists the intent link', async () => {
    vi.useFakeTimers();
    const h = harness({ intentType: 'transfer' });
    let releaseLink = (): void => {};
    const pending = h.client.actions.transfer({ ...transfer, beforeOpen: () => new Promise<void>((resolve) => { releaseLink = resolve; }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.urls).toEqual([]);
    releaseLink();
    await expect(pending).resolves.toMatchObject({ intentId });
    expect(new URL(h.urls[0] ?? '').searchParams.get('display')).toBe('embed');
    h.frame.close();
    await vi.advanceTimersByTimeAsync(2000);
  });

  it('reports only authoritative completed action state and leaves iframe dismissal to the merchant', async () => {
    vi.useFakeTimers();
    const h = harness({ intentType: 'transfer' });
    await h.client.actions.transfer(transfer);
    h.emit({ type: 'superrare-connect:intent-status', intentId, status: 'completed' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.settled).toEqual([]);
    h.setStatus('completed');
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.settled).toMatchObject([{ intentId, status: 'completed' }]);
    expect(h.frame.closed).toBe(false);
    expect(h.popupOpen).not.toHaveBeenCalled();
  });

  it('stops an unavailable embedded action without reporting completion or automatically restarting it', async () => {
    vi.useFakeTimers();
    const h = harness({ intentType: 'transfer' });
    await h.client.actions.transfer(transfer);
    h.emit({ type: 'superrare-connect:embed-unavailable', intentId }, { source: {} });
    expect(h.unavailable).toEqual([]);
    h.emit({ type: 'superrare-connect:embed-unavailable', intentId });
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.unavailable).toMatchObject([{ code: 'embed_unavailable', intentId }]);
    expect(h.settled).toEqual([]);
    expect(h.requests.filter((request) => request.method === 'GET')).toEqual([]);
    expect(h.popupOpen).not.toHaveBeenCalled();
  });

  it('exchanges game authorization after embedded login without new UI when storage is disabled', async () => {
    vi.useFakeTimers();
    const h = harness({ onNavigate: () => h.emit(h.callback()) });
    await h.client.auth.login();
    const hostedUrls = [...h.urls];
    const game = h.client.games.forGame({
      appId: '20000000-0000-0000-0000-000000000001', groupId: '40000000-0000-0000-0000-000000000001',
    });
    await expect(game.connect()).resolves.toMatchObject({ authorizationToken: 'game-only-token' });
    await expect(game.connect()).resolves.toMatchObject({ authorizationToken: 'game-only-token' });
    expect(game.getAuthorization()).toMatchObject({ authorizationToken: 'game-only-token' });
    expect(h.urls).toEqual(hostedUrls);
    expect(h.popupOpen).not.toHaveBeenCalled();
    expect(h.requests.filter((request) => new URL(request.url).pathname.endsWith('/authorizations'))).toHaveLength(1);
    expect(h.requests.some((request) => /\/(consents|uses)$/.test(new URL(request.url).pathname))).toBe(false);
  });
});

describe('display option with an embed adapter', () => {
  it('runs embedded when display is embed', async () => {
    vi.useFakeTimers();
    const h = harness({ display: 'embed', onNavigate: () => h.emit(h.callback()) });

    await expect(h.client.auth.login()).resolves.toMatchObject({ status: 'authenticated' });
    expect(new URL(h.urls[0] ?? '').searchParams.get('display')).toBe('embed');
    expect(h.popupOpen).not.toHaveBeenCalled();
  });

  it('lets display popup override the embed adapter', async () => {
    const embedOpen = vi.fn((): ConnectEmbedWindow | null => null);
    const popupOpen = vi.fn(() => null);
    const client = createSuperRareClient({
      apiUrl: 'https://api.test',
      display: 'popup',
      embed: { open: embedOpen, onUnavailable: () => {} },
      popup: { open: popupOpen, messageEvents: { subscribe: () => () => {} } },
      fetch: vi.fn(),
    });

    await expect(client.auth.login()).rejects.toMatchObject({ name: 'ConnectPopupBlockedError' });
    expect(popupOpen).toHaveBeenCalledTimes(1);
    expect(embedOpen).not.toHaveBeenCalled();
  });

  it('lets display redirect override the embed adapter', async () => {
    const open = vi.fn((): ConnectEmbedWindow | null => null);
    const assign = vi.fn<(url: string) => void>();
    const client = createSuperRareClient({
      apiUrl: 'https://api.test',
      display: 'redirect',
      embed: { open, onUnavailable: () => {} },
      navigation: { assign },
      fetch: async () => Response.json({ data: { intentId, url: `${origin}/action/${intentId}`, expiresAt } }),
    });

    await client.actions.transfer(transfer);

    expect(assign).toHaveBeenCalledWith(`${origin}/action/${intentId}`);
    expect(open).not.toHaveBeenCalled();
  });

  it('refuses display embed without an embed adapter', () => {
    expect(() => createSuperRareClient({ display: 'embed' })).toThrow("display: 'embed' needs an embed adapter");
  });
});
