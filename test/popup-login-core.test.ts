import { describe, expect, it } from 'vitest';
import {
  CONNECT_AUTH_CALLBACK_MESSAGE_TYPE,
  parseConnectAuthCallbackMessage,
  hasConnectPostMessage,
  parseConnectRequestOriginChallenge,
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

describe('browser requester origin challenge', () => {
  const source = { postMessage(_message: unknown, _targetOrigin: string): void {} };
  const challenge = {
    type: 'superrare-connect:request-origin-challenge',
    intentId: 'connect_intent_login',
    nonce: 'fresh-browser-nonce',
  };
  const event = {
    data: challenge, origin: expectedOrigin, source, expectedOrigin,
    expectedSource: source, intentId: challenge.intentId,
  };

  it('accepts only a challenge bound to the exact hosted window, origin and intent', () => {
    expect(parseConnectRequestOriginChallenge(event)).toEqual({
      intentId: challenge.intentId, nonce: challenge.nonce,
    });
    for (const mismatch of [
      { source: { postMessage: source.postMessage } },
      { source: undefined },
      { expectedSource: undefined, source: undefined },
      { expectedSource: null, source: null },
      { origin: 'https://evil.test' },
      { data: { ...challenge, intentId: 'another-intent' } },
      { data: { ...challenge, type: 'superrare-connect:auth-callback' } },
    ]) {
      expect(parseConnectRequestOriginChallenge({ ...event, ...mismatch })).toBeUndefined();
    }
  });

  it.each([undefined, null, 42, {}, '', 'x'.repeat(129)])('rejects malformed or unbounded nonce %#', (nonce) => {
    expect(parseConnectRequestOriginChallenge({ ...event, data: { ...challenge, nonce } })).toBeUndefined();
  });

  it('accepts the hosted maximum nonce length', () => {
    const nonce = 'x'.repeat(128);
    expect(parseConnectRequestOriginChallenge({ ...event, data: { ...challenge, nonce } }))
      .toEqual({ intentId: challenge.intentId, nonce });
  });

  it('narrows a callable window postMessage without requiring it on legacy adapters', () => {
    expect(hasConnectPostMessage(source)).toBe(true);
    for (const value of [undefined, null, {}, { postMessage: 'not callable' }, 42]) {
      expect(hasConnectPostMessage(value)).toBe(false);
    }
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
