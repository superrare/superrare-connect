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
