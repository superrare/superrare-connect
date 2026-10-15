import { describe, expect, it } from 'vitest';
import {
  appendConnectEmbedDisplay,
  parseConnectEmbedMessage,
} from '../src/embed-core.js';

const expectedOrigin = 'https://connect.superrare.test';
const expectedSource = {};
const intentId = 'connect_intent_checkout';
const terminalMessage = {
  type: 'superrare-connect:intent-status',
  intentId,
  status: 'completed',
};
const unavailableMessage = {
  type: 'superrare-connect:embed-unavailable',
  intentId,
};

function parseMessage(data: unknown) {
  return parseConnectEmbedMessage({
    data,
    origin: expectedOrigin,
    source: expectedSource,
    expectedOrigin,
    expectedSource,
    intentId,
  });
}

describe('parseConnectEmbedMessage', () => {
  it('accepts all terminal statuses as reconciliation hints', () => {
    for (const status of ['completed', 'cancelled', 'failed', 'expired']) {
      const message = { ...terminalMessage, status };
      expect(parseMessage(message)).toEqual({ ok: true, message });
    }
  });

  it('preserves optional transaction hash and error strings', () => {
    for (const fields of [
      { transactionHash: '0x1234' },
      { error: 'Transaction rejected' },
      { transactionHash: '0x1234', error: 'Reconciliation pending' },
      { transactionHash: '', error: '' },
    ]) {
      const message = { ...terminalMessage, ...fields };
      expect(parseMessage(message)).toEqual({ ok: true, message });
    }
  });

  it('accepts embed-unavailable without requiring a terminal status', () => {
    expect(parseMessage(unavailableMessage)).toEqual({
      ok: true,
      message: unavailableMessage,
    });
  });

  it('rejects foreign and deceptively similar origins for both variants', () => {
    for (const data of [terminalMessage, unavailableMessage]) {
      for (const origin of [
        'https://evil.test',
        'https://connect.superrare.test.evil.test',
        'http://connect.superrare.test',
        'https://connect.superrare.test:8443',
        'null',
      ]) {
        expect(parseConnectEmbedMessage({
          data,
          origin,
          source: expectedSource,
          expectedOrigin,
          expectedSource,
          intentId,
        })).toEqual({ ok: false, error: 'origin_mismatch' });
      }
    }
  });

  it('rejects messages from another window even on the trusted origin', () => {
    for (const data of [terminalMessage, unavailableMessage]) {
      for (const source of [{}, null, undefined]) {
        expect(parseConnectEmbedMessage({
          data,
          origin: expectedOrigin,
          source,
          expectedOrigin,
          expectedSource,
          intentId,
        })).toEqual({ ok: false, error: 'source_mismatch' });
      }
    }
  });

  it('rejects a missing expected window even when the sources match', () => {
    for (const source of [null, undefined]) {
      expect(parseConnectEmbedMessage({
        data: terminalMessage,
        origin: expectedOrigin,
        source,
        expectedOrigin,
        expectedSource: source,
        intentId,
      })).toEqual({ ok: false, error: 'source_mismatch' });
    }
  });

  it('rejects stale or unrelated intent IDs for both variants', () => {
    for (const message of [terminalMessage, unavailableMessage]) {
      expect(parseMessage({ ...message, intentId: 'connect_intent_previous' }))
        .toEqual({ ok: false, error: 'intent_mismatch' });
    }
  });

  it('rejects non-message values and missing, unknown, or non-string types', () => {
    for (const data of [
      undefined, null, 'text', 42, [], {},
      { ...terminalMessage, type: undefined },
      { ...terminalMessage, type: 'superrare-connect:auth-callback' },
      { ...terminalMessage, type: 42 },
    ]) {
      expect(parseMessage(data)).toEqual({ ok: false, error: 'malformed_message' });
    }
  });

  it('requires a nonempty string intent ID on both variants', () => {
    for (const message of [terminalMessage, unavailableMessage]) {
      for (const malformedIntentId of [undefined, null, '', 42]) {
        expect(parseMessage({ ...message, intentId: malformedIntentId }))
          .toEqual({ ok: false, error: 'malformed_message' });
      }
    }
  });

  it('rejects missing, nonterminal, and non-string statuses', () => {
    for (const status of [undefined, null, '', 'pending', 'authenticated', 42]) {
      expect(parseMessage({ ...terminalMessage, status }))
        .toEqual({ ok: false, error: 'malformed_message' });
    }
  });

  it('rejects non-string optional transaction hashes and errors', () => {
    for (const value of [null, 42, {}, []]) {
      expect(parseMessage({ ...terminalMessage, transactionHash: value }))
        .toEqual({ ok: false, error: 'malformed_message' });
      expect(parseMessage({ ...terminalMessage, error: value }))
        .toEqual({ ok: false, error: 'malformed_message' });
    }
  });
});

describe('appendConnectEmbedDisplay', () => {
  it('preserves hosted route, intent query values, duplicate keys, and fragment', () => {
    const result = new URL(appendConnectEmbedDisplay(
      'https://connect.superrare.test/checkout/nested?intentId=checkout%2F123&state=a%2Bb&tag=one&tag=two#resume',
    ));
    expect(result.origin).toBe(expectedOrigin);
    expect(result.pathname).toBe('/checkout/nested');
    expect(result.searchParams.get('intentId')).toBe('checkout/123');
    expect(result.searchParams.get('state')).toBe('a+b');
    expect(result.searchParams.getAll('tag')).toEqual(['one', 'two']);
    expect(result.searchParams.getAll('display')).toEqual(['embed']);
    expect(result.hash).toBe('#resume');
  });

  it('replaces existing display values rather than appending a competing mode', () => {
    const result = new URL(appendConnectEmbedDisplay(
      'https://connect.superrare.test/login?display=popup&intentId=login&display=fullscreen',
    ));
    expect(result.searchParams.getAll('display')).toEqual(['embed']);
    expect(result.searchParams.get('intentId')).toBe('login');
  });

  it('supports a loopback hosted URL with no existing query', () => {
    expect(appendConnectEmbedDisplay('http://localhost:5004/action#continue'))
      .toBe('http://localhost:5004/action?display=embed#continue');
  });
});
