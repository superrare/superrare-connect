import { describe, expect, it } from 'vitest';
import { resolveConnectIntentOutcome } from '../src/status-core.js';

describe('resolveConnectIntentOutcome', () => {
  it.each([
    'pending',
    'requires_user',
    'processing',
  ] as const)('keeps %s intents pending', (status) => {
    expect(resolveConnectIntentOutcome({ status })).toEqual({ kind: 'pending' });
  });

  it('resolves completed intents', () => {
    expect(resolveConnectIntentOutcome({
      status: 'completed',
      result: { sessionId: 'connect_session_123' },
    })).toEqual({
      kind: 'completed',
      result: { sessionId: 'connect_session_123' },
    });
  });

  it.each([
    'failed',
    'cancelled',
    'expired',
  ] as const)('resolves %s intents as terminal failures', (status) => {
    expect(resolveConnectIntentOutcome({ status })).toEqual({
      kind: 'failed',
      status,
    });
  });
});
