import { describe, expect, it } from 'vitest';
import {
  buildConnectLoginIntentRequest,
  encodeBase64Url,
  pendingConnectAuthSchema,
  verifyConnectAuthCallbackAgainstPending,
  type PendingConnectAuth,
} from '../src/auth-flow-core.js';

const rfc7636CodeVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const rfc7636CodeChallenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

const pendingAuth: PendingConnectAuth = {
  intentId: 'connect_intent_123',
  state: 'state_123',
  expiresAt: '2026-06-22T00:00:00.000Z',
  codeVerifier: rfc7636CodeVerifier,
};

describe('encodeBase64Url', () => {
  it('encodes the RFC 7636 appendix B challenge from the SHA-256 of its verifier', async () => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rfc7636CodeVerifier));

    expect(encodeBase64Url(new Uint8Array(digest))).toBe(rfc7636CodeChallenge);
  });

  it('uses the URL-safe alphabet without padding', () => {
    expect(encodeBase64Url(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
  });
});

describe('buildConnectLoginIntentRequest', () => {
  it('builds a login intent request with normalized returnPath and generated state', () => {
    expect(buildConnectLoginIntentRequest({
      codeChallenge: rfc7636CodeChallenge,
      returnPath: '/account',
      state: 'state_123',
      initiatingOrigin: 'https://artist.example',
    })).toEqual({
      ok: true,
      request: {
        action: { type: 'login' },
        pkce: { codeChallenge: rfc7636CodeChallenge, codeChallengeMethod: 'S256' },
        returnPath: '/account',
        state: 'state_123',
        initiatingOrigin: 'https://artist.example',
      },
    });
  });

  it('opts in to browser delivery while preserving the S256 challenge', () => {
    const result = buildConnectLoginIntentRequest({
      codeChallenge: rfc7636CodeChallenge, state: 'state_123', authDelivery: 'browser',
    });
    expect(result).toMatchObject({
      ok: true, request: {
        authDelivery: 'browser',
        pkce: { codeChallenge: rfc7636CodeChallenge, codeChallengeMethod: 'S256' },
      },
    });
  });

  it('rejects unsafe returnPath before API requests', () => {
    expect(buildConnectLoginIntentRequest({
      codeChallenge: rfc7636CodeChallenge,
      returnPath: 'https://evil.example/account',
      state: 'state_123',
    })).toEqual({
      ok: false,
      error: 'invalid_return_path',
    });
  });
});

describe('verifyConnectAuthCallbackAgainstPending', () => {
  it('accepts matching callback params and exchanges them with the pending verifier only', () => {
    expect(verifyConnectAuthCallbackAgainstPending({
      pendingAuth,
      callbackParams: {
        intentId: 'connect_intent_123',
        state: 'state_123',
        code: 'connect_auth_code_123',
        ...{ codeVerifier: 'injected_by_the_callback_url_injected_by_the_url' },
      },
    })).toEqual({
      ok: true,
      exchangeParams: {
        intentId: 'connect_intent_123',
        state: 'state_123',
        code: 'connect_auth_code_123',
        codeVerifier: rfc7636CodeVerifier,
      },
    });
  });

  it.each(['legacy-pending', 'browser-pending'] as const)('rejects cross-mode reuse of %s', (mode) => {
    expect(verifyConnectAuthCallbackAgainstPending({
      pendingAuth: mode === 'legacy-pending' ? pendingAuth : { ...pendingAuth, authDelivery: 'browser' },
      authDelivery: mode === 'legacy-pending' ? 'browser' : undefined,
      callbackParams: { intentId: pendingAuth.intentId, state: pendingAuth.state, code: 'one-time-code' },
    })).toEqual({ ok: false, error: 'auth_delivery_mismatch' });
  });

  it('retains browser delivery through storage parsing and verifies it explicitly', () => {
    const parsed = pendingConnectAuthSchema.parse({ ...pendingAuth, authDelivery: 'browser' });
    expect(parsed.authDelivery).toBe('browser');
    expect(verifyConnectAuthCallbackAgainstPending({
      pendingAuth: parsed, authDelivery: 'browser',
      callbackParams: { intentId: parsed.intentId, state: parsed.state, code: 'one-time-code' },
    })).toMatchObject({ ok: true, exchangeParams: { codeVerifier: rfc7636CodeVerifier } });
  });

  it('treats a pending record without a verifier as missing', () => {
    expect(pendingConnectAuthSchema.safeParse({
      intentId: 'connect_intent_123',
      state: 'state_123',
      expiresAt: '2026-06-22T00:00:00.000Z',
    }).success).toBe(false);
  });

  it('rejects missing pending auth', () => {
    expect(verifyConnectAuthCallbackAgainstPending({
      pendingAuth: undefined,
      callbackParams: {
        intentId: 'connect_intent_123',
        state: 'state_123',
        code: 'connect_auth_code_123',
      },
    })).toEqual({
      ok: false,
      error: 'missing_pending_auth',
    });
  });

  it('rejects mismatched intent IDs', () => {
    expect(verifyConnectAuthCallbackAgainstPending({
      pendingAuth,
      callbackParams: {
        intentId: 'connect_intent_different',
        state: 'state_123',
        code: 'connect_auth_code_123',
      },
    })).toEqual({
      ok: false,
      error: 'intent_mismatch',
    });
  });

  it('rejects mismatched states', () => {
    expect(verifyConnectAuthCallbackAgainstPending({
      pendingAuth,
      callbackParams: {
        intentId: 'connect_intent_123',
        state: 'state_different',
        code: 'connect_auth_code_123',
      },
    })).toEqual({
      ok: false,
      error: 'state_mismatch',
    });
  });
});
