import { describe, expect, it, vi } from 'vitest';
import { createSuperRareClient, type ConnectPopupMessageEvent } from '../src/client.js';
import { parseGameConsentMessage } from '../src/games-core.js';
import type { ConnectPopupWindow } from '../src/popup-core.js';

const appId = '20000000-0000-0000-0000-000000000001';
const groupId = '40000000-0000-0000-0000-000000000001';

const sessionResponse = (creditUse = false): Response => Response.json({
  version: '1',
  session: { id: 'session-1', token: 'play-token', expiresAt: '2030-01-01T00:00:00.000Z' },
  game: { id: appId, slug: 'game', title: 'Game', buildId: null },
  player: { kind: 'wallet', id: '0xabc', handle: null, displayName: '0xabc', avatarUrl: null, chainId: 1 },
  defaultLeaderboard: { key: 'default', seasonKey: 'all-time' },
  ...(creditUse ? { creditUse: { id: 'use-1', status: 'ready', credits: 1, token: 'consent-token' } } : {}),
}, { status: 201 });

describe('games namespace', () => {
  it('forwards the same idempotency key on free game retries', async () => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.url).toBe(`https://studio.test/api/v1/games/${appId}/sessions`);
      expect(request.headers.get('idempotency-key')).toBe('free-start-key-001');
      expect(await request.json()).toMatchObject({ idempotencyKey: 'free-start-key-001' });
      return sessionResponse();
    });
    const game = createSuperRareClient({ studioUrl: 'https://studio.test', fetch: fetchImplementation })
      .games.forGame({ appId });
    await game.start({ idempotencyKey: 'free-start-key-001' });
    await game.start({ idempotencyKey: 'free-start-key-001' });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it('retries a paid start with the bound one-use consent and stable key', async () => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.url).toBe(`https://studio.test/api/v1/credit-groups/${groupId}/apps/${appId}/uses`);
      expect(request.headers.get('authorization')).toBe('GameConsent narrow-token');
      expect(request.headers.get('idempotency-key')).toBe('stable-start-001');
      expect(await request.json()).toMatchObject({ idempotencyKey: 'stable-start-001' });
      return sessionResponse(true);
    });
    const game = createSuperRareClient({ studioUrl: 'https://studio.test', fetch: fetchImplementation })
      .games.forGame({ appId, groupId });
    const consent = { appId, groupId, consentId: 'consent-1', consentToken: 'narrow-token', expiresAt: '2030-01-01T00:00:00Z' };
    await game.startWithConsent({ idempotencyKey: 'stable-start-001', consent });
    await game.startWithConsent({ idempotencyKey: 'stable-start-001', consent });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it('validates hosted approval origin, source, state, app, and group before starting', async () => {
    let listener: ((event: ConnectPopupMessageEvent) => void) | undefined;
    const popup: ConnectPopupWindow = {
      closed: false,
      close() { popup.closed = true; },
      location: { replace() { /* Approval URL opens directly. */ } },
    };
    let approvalUrl = '';
    const fetchImplementation = vi.fn(async () => sessionResponse(true));
    const game = createSuperRareClient({
      studioUrl: 'https://studio.test', initiatingOrigin: 'https://game.test', fetch: fetchImplementation,
      popup: {
        open(url) { approvalUrl = url; return popup; },
        messageEvents: { subscribe(next) { listener = next; return () => { listener = undefined; }; } },
      },
    }).games.forGame({ appId, groupId });
    const started = game.startWithApproval({ idempotencyKey: 'approval-start-001' });
    const state = new URL(approvalUrl).searchParams.get('state');
    expect(state).toBeTruthy();
    listener?.({ origin: 'https://evil.test', source: popup, data: { type: 'superrare-connect:game-consent' } });
    expect(fetchImplementation).not.toHaveBeenCalled();
    listener?.({ origin: 'https://studio.test', source: {}, data: { type: 'superrare-connect:game-consent' } });
    expect(fetchImplementation).not.toHaveBeenCalled();
    listener?.({ origin: 'https://studio.test', source: popup, data: {
      type: 'superrare-connect:game-consent', state, appId, groupId,
      consentId: 'consent-1', consentToken: 'narrow-token', expiresAt: '2030-01-01T00:00:00Z',
    } });
    await expect(started).resolves.toMatchObject({ creditUse: { status: 'ready' } });
  });

  it('settles paid approval when message listener cleanup throws', async () => {
    let listener: ((event: ConnectPopupMessageEvent) => void) | undefined;
    let approvalUrl = '';
    const popup: ConnectPopupWindow = {
      closed: false,
      close() { popup.closed = true; },
      location: { replace() { /* Approval URL opens directly. */ } },
    };
    const fetchImplementation = vi.fn(async () => sessionResponse(true));
    const game = createSuperRareClient({
      studioUrl: 'https://studio.test',
      initiatingOrigin: 'https://game.test',
      fetch: fetchImplementation,
      popup: {
        open(url) { approvalUrl = url; return popup; },
        messageEvents: { subscribe(next) {
          listener = next;
          return () => { throw new Error('Cleanup failed.'); };
        } },
      },
    }).games.forGame({ appId, groupId });
    const started = game.startWithApproval({ idempotencyKey: 'cleanup-start-001' });
    const approval = new URL(approvalUrl);
    listener?.({
      origin: approval.origin,
      source: popup,
      data: {
        type: 'superrare-connect:game-consent',
        state: approval.searchParams.get('state'),
        appId,
        groupId,
        consentId: 'consent-1',
        consentToken: 'narrow-token',
        expiresAt: '2030-01-01T00:00:00Z',
      },
    });
    await expect(started).resolves.toMatchObject({ creditUse: { status: 'ready' } });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(popup.closed).toBe(true);
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
    const game = createSuperRareClient({ studioUrl: 'https://studio.test', fetch: fetchImplementation }).games.forGame({ appId });
    await expect(game.submitClientAssertedScore({ sessionToken: 'play-token', score: 42, idempotencyKey: 'score-key-001' }))
      .resolves.toMatchObject({ score: '42' });
    await expect(game.startServerValidatedRun({ sessionToken: 'play-token', eventId: 'event-1', idempotencyKey: 'run-key-001' }))
      .resolves.toMatchObject({ run: { runId: 'run-1' } });
  });
});

describe('game consent message parser', () => {
  it('rejects mismatched state and bindings', () => {
    const data = { type: 'superrare-connect:game-consent', state: 'wrong', appId, groupId,
      consentId: 'c', consentToken: 't', expiresAt: 'later' };
    expect(parseGameConsentMessage({ data, origin: 'https://studio.test', expectedOrigin: 'https://studio.test',
      expectedState: 'right', appId, groupId })).toEqual({ ok: false, error: 'state_mismatch' });
  });
});
