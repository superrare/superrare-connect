import { describe, expect, it } from 'vitest';
import {
  CONNECT_AUTH_CALLBACK_MESSAGE_TYPE,
  getConnectPopupLoginDeadline,
  parseConnectAuthCallbackMessage,
  resolveConnectHostedUrl,
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
  it('parses a future ISO expiry into epoch milliseconds', () => {
    expect(getConnectPopupLoginDeadline({
      expiresAt: '2027-01-01T00:00:00.000Z',
      now: 1_000,
      fallbackMilliseconds: 60_000,
    })).toBe(Date.parse('2027-01-01T00:00:00.000Z'));
  });

  it('falls back to now plus the fallback window for an unparseable expiry', () => {
    expect(getConnectPopupLoginDeadline({
      expiresAt: 'not-a-date',
      now: 1_000,
      fallbackMilliseconds: 60_000,
    })).toBe(61_000);
  });

  it('treats an already-past expiry as clock skew and uses the fallback window', () => {
    // A fresh intent whose expiry is behind the client clock means the client
    // is running ahead; using the parsed deadline would expire a valid login.
    expect(getConnectPopupLoginDeadline({
      expiresAt: '2020-01-01T00:00:00.000Z',
      now: Date.parse('2026-01-01T00:00:00.000Z'),
      fallbackMilliseconds: 60_000,
    })).toBe(Date.parse('2026-01-01T00:00:00.000Z') + 60_000);
  });
});

describe('resolveConnectHostedUrl', () => {
  it('accepts https and reports its origin', () => {
    expect(resolveConnectHostedUrl('https://connect.superrare.test/login?intentId=a'))
      .toEqual({ ok: true, origin: 'https://connect.superrare.test' });
  });

  it('accepts plaintext http only for loopback hosts (local development)', () => {
    for (const url of [
      'http://localhost:5004/login',
      'http://127.0.0.1:5004/login',
      'http://[::1]:5004/login',
    ]) {
      expect(resolveConnectHostedUrl(url)).toEqual({ ok: true, origin: new URL(url).origin });
    }
  });

  it('rejects plaintext http for a non-loopback host (downgrade / on-path swap)', () => {
    for (const url of [
      'http://connect.superrare.com/login',
      'http://evil.test/login',
    ]) {
      expect(resolveConnectHostedUrl(url)).toEqual({ ok: false, error: 'unsupported_protocol' });
    }
  });

  it('rejects executable and non-web protocols', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'about:blank',
    ]) {
      expect(resolveConnectHostedUrl(url))
        .toEqual({ ok: false, error: 'unsupported_protocol' });
    }
  });

  it('rejects an unparseable URL', () => {
    expect(resolveConnectHostedUrl('not a url'))
      .toEqual({ ok: false, error: 'unparseable' });
  });
});
