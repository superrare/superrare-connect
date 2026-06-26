import { describe, expect, it } from 'vitest';
import {
  parseStoredConnectSession,
  readConnectSessionFromStorage,
  removeConnectSessionFromStorage,
  serializeConnectSession,
  writeConnectSessionToStorage,
  type ConnectSession,
  type ConnectSessionStorage,
} from '../src/session-storage-core.js';

const session: ConnectSession = {
  sessionId: 'connect_session_123',
  userId: 'user_123',
  address: '0x0000000000000000000000000000000000000001',
  expiresAt: '2026-06-22T00:00:00.000Z',
};

describe('Connect session storage core', () => {
  it('round-trips stored Connect sessions', () => {
    const serialized = serializeConnectSession(session);

    expect(parseStoredConnectSession(serialized)).toEqual(session);
  });

  it('ignores malformed stored Connect sessions', () => {
    expect(parseStoredConnectSession('not json')).toBeUndefined();
    expect(parseStoredConnectSession(JSON.stringify({ sessionId: 'missing-fields' }))).toBeUndefined();
  });

  it('reads, writes, and clears the configured storage key', () => {
    const storage = createMemoryStorage();

    writeConnectSessionToStorage(storage, 'connect-session', session);
    expect(readConnectSessionFromStorage(storage, 'connect-session')).toEqual(session);

    removeConnectSessionFromStorage(storage, 'connect-session');
    expect(readConnectSessionFromStorage(storage, 'connect-session')).toBeUndefined();
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
