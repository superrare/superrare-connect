import { describe, expect, it } from 'vitest';
import {
  buildConnectLoginIntentRequest,
  verifyConnectAuthCallbackAgainstPending,
  type PendingConnectAuth,
} from '../src/auth-flow-core.js';

const pendingAuth: PendingConnectAuth = {
  intentId: 'connect_intent_123',
  state: 'state_123',
  expiresAt: '2026-06-22T00:00:00.000Z',
};

describe('buildConnectLoginIntentRequest', () => {
  it('builds a login intent request with normalized returnPath and generated state', () => {
    expect(buildConnectLoginIntentRequest({
      returnPath: '/account',
      state: 'state_123',
      initiatingOrigin: 'https://artist.example',
    })).toEqual({
      ok: true,
      request: {
        action: { type: 'login' },
        returnPath: '/account',
        state: 'state_123',
        initiatingOrigin: 'https://artist.example',
      },
    });
  });

  it('rejects unsafe returnPath before API requests', () => {
    expect(buildConnectLoginIntentRequest({
      returnPath: 'https://evil.example/account',
      state: 'state_123',
    })).toEqual({
      ok: false,
      error: 'invalid_return_path',
    });
  });
});

describe('verifyConnectAuthCallbackAgainstPending', () => {
  it('accepts matching callback params', () => {
    expect(verifyConnectAuthCallbackAgainstPending({
      pendingAuth,
      callbackParams: {
        intentId: 'connect_intent_123',
        state: 'state_123',
        code: 'connect_auth_code_123',
      },
    })).toEqual({ ok: true });
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
