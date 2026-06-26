import { describe, expect, it } from 'vitest';
import { parseConnectAuthCallbackSearchParams } from '../src/callback-core.js';

describe('parseConnectAuthCallbackSearchParams', () => {
  it('parses hosted login callback parameters', () => {
    const result = parseConnectAuthCallbackSearchParams(new URLSearchParams({
      intentId: 'connect_intent_123',
      state: 'state_123',
      code: 'connect_auth_code_123',
    }));

    expect(result).toEqual({
      ok: true,
      params: {
        intentId: 'connect_intent_123',
        state: 'state_123',
        code: 'connect_auth_code_123',
      },
    });
  });

  it.each([
    ['intentId', 'missing_intent_id'],
    ['state', 'missing_state'],
    ['code', 'missing_code'],
  ] as const)('rejects callbacks missing %s', (parameter, error) => {
    const searchParams = new URLSearchParams({
      intentId: 'connect_intent_123',
      state: 'state_123',
      code: 'connect_auth_code_123',
    });
    searchParams.delete(parameter);

    expect(parseConnectAuthCallbackSearchParams(searchParams)).toEqual({
      ok: false,
      error,
    });
  });

  it.each([
    ['intentId', 'duplicate_intent_id'],
    ['state', 'duplicate_state'],
    ['code', 'duplicate_code'],
  ] as const)('rejects callbacks with duplicate %s values', (parameter, error) => {
    const searchParams = new URLSearchParams({
      intentId: 'connect_intent_123',
      state: 'state_123',
      code: 'connect_auth_code_123',
    });
    searchParams.append(parameter, 'duplicate');

    expect(parseConnectAuthCallbackSearchParams(searchParams)).toEqual({
      ok: false,
      error,
    });
  });

  it.each([
    ['intentId', 'malformed_intent_id'],
    ['state', 'malformed_state'],
    ['code', 'malformed_code'],
  ] as const)('rejects blank %s values', (parameter, error) => {
    const searchParams = new URLSearchParams({
      intentId: 'connect_intent_123',
      state: 'state_123',
      code: 'connect_auth_code_123',
    });
    searchParams.set(parameter, ' ');

    expect(parseConnectAuthCallbackSearchParams(searchParams)).toEqual({
      ok: false,
      error,
    });
  });
});
