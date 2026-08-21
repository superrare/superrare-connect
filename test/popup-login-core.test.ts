import { describe, expect, it } from 'vitest';
import {
  CONNECT_AUTH_CALLBACK_MESSAGE_TYPE,
  getConnectPopupLoginDeadline,
  parseConnectAuthCallbackMessage,
} from '../src/popup-login-core.js';

const expectedOrigin = 'https://connect.superrare.test';

const validMessage = {
  type: CONNECT_AUTH_CALLBACK_MESSAGE_TYPE,
  intentId: 'connect_intent_login',
  state: 'state_login',
  code: 'connect_auth_code_login',
};

describe('parseConnectAuthCallbackMessage', () => {
  it('accepts a valid callback message from the expected origin', () => {
    expect(parseConnectAuthCallbackMessage({
      data: validMessage,
      origin: expectedOrigin,
      expectedOrigin,
    })).toEqual({
      ok: true,
      params: {
        intentId: 'connect_intent_login',
        state: 'state_login',
        code: 'connect_auth_code_login',
      },
    });
  });

  it('ignores messages that are not auth callbacks', () => {
    for (const data of [undefined, null, 'text', 42, {}, { type: 'other' }]) {
      expect(parseConnectAuthCallbackMessage({
        data,
        origin: expectedOrigin,
        expectedOrigin,
      })).toEqual({ ok: false, error: 'not_auth_callback' });
    }
  });

  it('rejects an auth callback from a foreign origin', () => {
    expect(parseConnectAuthCallbackMessage({
      data: validMessage,
      origin: 'https://evil.test',
      expectedOrigin,
    })).toEqual({ ok: false, error: 'origin_mismatch' });
  });

  it('rejects an auth callback with missing or empty parameters', () => {
    for (const data of [
      { type: CONNECT_AUTH_CALLBACK_MESSAGE_TYPE, intentId: 'a', state: 'b' },
      { type: CONNECT_AUTH_CALLBACK_MESSAGE_TYPE, intentId: '', state: 'b', code: 'c' },
      { type: CONNECT_AUTH_CALLBACK_MESSAGE_TYPE, intentId: 'a', state: 'b', code: 42 },
    ]) {
      expect(parseConnectAuthCallbackMessage({
        data,
        origin: expectedOrigin,
        expectedOrigin,
      })).toEqual({ ok: false, error: 'malformed_message' });
    }
  });
});

describe('getConnectPopupLoginDeadline', () => {
  it('parses an ISO expiry into epoch milliseconds', () => {
    expect(getConnectPopupLoginDeadline({
      expiresAt: '2027-01-01T00:00:00.000Z',
      now: 1_000,
      fallbackMs: 60_000,
    })).toBe(Date.parse('2027-01-01T00:00:00.000Z'));
  });

  it('falls back to now plus the fallback window for an unparseable expiry', () => {
    expect(getConnectPopupLoginDeadline({
      expiresAt: 'not-a-date',
      now: 1_000,
      fallbackMs: 60_000,
    })).toBe(61_000);
  });
});
