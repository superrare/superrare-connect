import { describe, expect, it } from 'vitest';
import {
  parseStoredConnectCredentials,
  readConnectCredentialsFromStorage,
  removeConnectSessionFromStorage,
  serializeConnectCredentials,
  writeConnectCredentialsToStorage,
  type ConnectAuthCredentials,
  type ConnectSessionStorage,
} from '../src/session-storage-core.js';

const credentials: ConnectAuthCredentials = {
  session: {
    sessionId: 'connect_session_123',
    userId: 'user_123',
    address: '0x0000000000000000000000000000000000000001',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  },
  refreshToken: 'connect_refresh_123',
  refreshExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
};

const malformedCredentials: unknown[] = [
  null,
  [],
  {},
  credentials.session,
  { session: credentials.session },
  { ...credentials, refreshToken: undefined },
  { ...credentials, refreshToken: '' },
  { ...credentials, refreshToken: 123 },
  { ...credentials, refreshToken: 'x'.repeat(513) },
  { ...credentials, refreshExpiresAt: undefined },
  { ...credentials, refreshExpiresAt: 'not a date' },
  { ...credentials, refreshExpiresAt: '2026-02-30T00:00:00.000Z' },
  { ...credentials, refreshExpiresAt: '2026-10-02' },
  { ...credentials, session: { ...credentials.session, sessionId: '' } },
  { ...credentials, session: { ...credentials.session, userId: '' } },
  { ...credentials, session: { ...credentials.session, address: '' } },
  { ...credentials, session: { ...credentials.session, expiresAt: 'not a date' } },
  { ...credentials, session: { ...credentials.session, expiresAt: '2026-02-30T00:00:00.000Z' } },
  { ...credentials, session: { ...credentials.session, expiresAt: '2026-10-02' } },
];

describe('Connect credential storage core', () => {
  it('round-trips the access session and its rotating refresh credentials', () => {
    const serialized = serializeConnectCredentials(credentials);

    expect(parseStoredConnectCredentials(serialized)).toEqual(credentials);
  });

  it('ignores malformed JSON instead of preventing client initialization', () => {
    expect(parseStoredConnectCredentials('not json')).toBeUndefined();
  });

  it.each(malformedCredentials)('rejects incomplete or invalid stored credentials %#', (value) => {
    expect(parseStoredConnectCredentials(JSON.stringify(value))).toBeUndefined();
  });

  it('retains an expired access session so a valid refresh credential can renew it', () => {
    const renewableCredentials: ConnectAuthCredentials = {
      ...credentials,
      session: {
        ...credentials.session,
        expiresAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      },
    };

    expect(parseStoredConnectCredentials(serializeConnectCredentials(renewableCredentials)))
      .toEqual(renewableCredentials);
  });

  it('does not leak stored refresh fields into the identity-only session', () => {
    const value = {
      ...credentials,
      session: {
        ...credentials.session,
        refreshToken: credentials.refreshToken,
        refreshExpiresAt: credentials.refreshExpiresAt,
      },
    };

    expect(parseStoredConnectCredentials(JSON.stringify(value))).toEqual(credentials);
  });

  it('replaces rotating credentials and clears only the configured storage key', () => {
    const storage = createMemoryStorage();
    const replacement: ConnectAuthCredentials = {
      ...credentials,
      session: { ...credentials.session, sessionId: 'connect_session_replacement' },
      refreshToken: 'connect_refresh_replacement',
    };
    writeConnectCredentialsToStorage(storage, 'other-session', credentials);
    writeConnectCredentialsToStorage(storage, 'connect-session', credentials);
    writeConnectCredentialsToStorage(storage, 'connect-session', replacement);

    expect(readConnectCredentialsFromStorage(storage, 'connect-session')).toEqual(replacement);
    expect(storage.getItem('connect-session')).toBe(serializeConnectCredentials(replacement));

    removeConnectSessionFromStorage(storage, 'connect-session');
    expect(readConnectCredentialsFromStorage(storage, 'connect-session')).toBeUndefined();
    expect(readConnectCredentialsFromStorage(storage, 'other-session')).toEqual(credentials);
  });
});

function createMemoryStorage(): ConnectSessionStorage {
  const values = new Map<string, string>();

  return {
    getItem(key): string | null {
      return values.get(key) ?? null;
    },
    setItem(key, value): void {
      values.set(key, value);
    },
    removeItem(key): void {
      values.delete(key);
    },
  };
}
