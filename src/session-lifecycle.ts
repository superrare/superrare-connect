import {
  refreshConnectAuthSession,
  revokeConnectAuthSession,
  type ConnectAuthApiOptions,
  type ConnectAuthCredentials,
} from './api.js';
import { SuperRareConnectApiError } from './errors.js';
import {
  parseStoredConnectCredentialRecord,
  removeConnectSessionFromStorage,
  serializeConnectCredentials,
  type ConnectSession,
  type ConnectSessionStorage,
  type ConnectStoredAuthCredentials,
} from './session-storage-core.js';

type SessionListener = (session: ConnectSession | undefined) => void;
type CredentialSlot = {
  credentials: ConnectAuthCredentials | undefined;
  serializedCredentials: string | null | undefined;
  lineageId: string | undefined;
  generation: number;
  replacementGeneration: number;
  logoutGeneration: number | undefined;
  persistenceEnabled: boolean;
  refresh: Promise<ConnectAuthCredentials | undefined> | undefined;
  listeners: Set<SessionListener>;
};

const sharedSlots = new WeakMap<ConnectSessionStorage, Map<string, CredentialSlot>>();
const refreshLeadMilliseconds = 60_000;
const defaultApiOrigin = 'https://api.superrare.com';

export type ConnectSessionLifecycle = {
  getReplacementGeneration: () => number;
  getSession: () => ConnectSession | undefined;
  getCurrentSession: () => Promise<ConnectSession | undefined>;
  commit: (credentials: ConnectAuthCredentials, shouldCommit: () => boolean) => Promise<boolean>;
  clear: () => void;
  logout: () => Promise<void>;
  onChange: (listener: SessionListener) => () => void;
};

/** Persisted credentials from different Rare API environments never share a slot. */
export function getConnectCredentialStorageKey(baseKey: string, apiUrl?: string): string {
  const origin = new URL(apiUrl?.trim() || defaultApiOrigin).origin;
  return origin === defaultApiOrigin ? baseKey : `${baseKey}:${encodeURIComponent(origin)}`;
}

export function createConnectSessionLifecycle(input: {
  storage: ConnectSessionStorage | undefined;
  storageKey: string;
  apiOptions: ConnectAuthApiOptions;
}): ConnectSessionLifecycle {
  const slot = getCredentialSlot(input.storage, input.storageKey);
  const notify = (): void => {
    slot.listeners.forEach((listener) => listener(slot.credentials?.session));
  };
  const read = (): ConnectAuthCredentials | undefined => {
    if (slot.logoutGeneration !== undefined) return undefined;
    if (!slot.persistenceEnabled || input.storage === undefined) return slot.credentials;
    let storedRecord: ConnectStoredAuthCredentials | undefined;
    try {
      const serialized = input.storage.getItem(input.storageKey);
      if (serialized === slot.serializedCredentials) return slot.credentials;
      slot.serializedCredentials = serialized;
      storedRecord = serialized === null ? undefined : parseStoredConnectCredentialRecord(serialized);
    } catch {
      // Blocked storage is an in-memory mode, not a failed authentication.
      slot.persistenceEnabled = false;
      return slot.credentials;
    }
    const stored = storedRecord?.credentials;
    const lineageId = storedRecord?.lineageId;
    if (!sameCredentials(slot.credentials, stored) || slot.lineageId !== lineageId) {
      if (
        slot.lineageId !== lineageId ||
        slot.credentials?.session.userId !== stored?.session.userId ||
        slot.credentials?.session.address !== stored?.session.address
      ) slot.replacementGeneration += 1;
      slot.credentials = stored;
      slot.lineageId = lineageId;
      slot.generation += 1;
    }
    return slot.credentials;
  };
  const persist = (credentials: ConnectAuthCredentials | undefined): void => {
    if (!slot.persistenceEnabled || input.storage === undefined) return;
    try {
      if (credentials === undefined) {
        removeConnectSessionFromStorage(input.storage, input.storageKey);
        slot.serializedCredentials = null;
      } else {
        const serialized = serializeConnectCredentials(
          credentials,
          slot.lineageId ?? credentials.session.sessionId,
        );
        input.storage.setItem(input.storageKey, serialized);
        slot.serializedCredentials = serialized;
      }
    } catch {
      slot.persistenceEnabled = false;
    }
  };
  const applyCredentials = (credentials: ConnectAuthCredentials, replacement: boolean): void => {
    slot.generation += 1;
    if (replacement) {
      slot.replacementGeneration += 1;
      slot.lineageId = credentials.session.sessionId;
    } else {
      slot.lineageId ??= credentials.session.sessionId;
    }
    slot.logoutGeneration = undefined;
    slot.credentials = credentials;
    persist(credentials);
    notify();
  };
  const commit = async (
    credentials: ConnectAuthCredentials,
    shouldCommit: () => boolean,
  ): Promise<boolean> => await withCredentialLock(input.storageKey, async () => {
    read();
    if (!shouldCommit()) return false;
    applyCredentials(credentials, true);
    return true;
  });
  const clear = (): void => {
    slot.generation += 1;
    slot.replacementGeneration += 1;
    slot.logoutGeneration = undefined;
    slot.credentials = undefined;
    slot.lineageId = undefined;
    persist(undefined);
    notify();
  };
  const refresh = (): Promise<ConnectAuthCredentials | undefined> => {
    if (slot.refresh !== undefined) return slot.refresh;
    const pending = withCredentialLock(input.storageKey, async () => {
      // Another tab may have rotated the single-use token while this tab waited.
      const credentials = read();
      if (credentials === undefined || !needsRefresh(credentials.session)) return credentials;
      const generation = slot.generation;
      if (Date.parse(credentials.refreshExpiresAt) <= Date.now()) {
        clear();
        return undefined;
      }
      try {
        const renewed = await refreshConnectAuthSession(credentials.refreshToken, input.apiOptions);
        const current = read();
        if (slot.generation === generation && sameCredentials(current, credentials)) {
          applyCredentials(renewed, false);
        }
        // Return the winner even after a local clear: logout must revoke the
        // rotated token, not the consumed token that started this request.
        return renewed;
      } catch (error) {
        const current = read();
        if (
          error instanceof SuperRareConnectApiError && error.status === 401 &&
          slot.generation === generation && sameCredentials(current, credentials)
        ) clear();
        // Outages retain credentials. A consumed-token 401 is never retried.
        throw error;
      }
    }).finally(() => {
      if (slot.refresh === pending) slot.refresh = undefined;
    });
    slot.refresh = pending;
    return pending;
  };
  const getCurrentSession = async (): Promise<ConnectSession | undefined> => {
    const credentials = read();
    if (credentials === undefined) return undefined;
    if (!needsRefresh(credentials.session)) return credentials.session;
    await refresh();
    const current = read();
    // A clear or newer login invalidated the request. Never return the stale
    // response, and never retry the same single-use refresh token implicitly.
    return current !== undefined && Date.parse(current.session.expiresAt) > Date.now()
      ? current.session : undefined;
  };
  const logout = async (): Promise<void> => {
    const credentials = read();
    const lineageId = slot.lineageId;
    const pending = slot.refresh;
    slot.generation += 1;
    slot.replacementGeneration += 1;
    const logoutGeneration = slot.generation;
    slot.logoutGeneration = logoutGeneration;
    slot.credentials = undefined;
    let notificationFailed = false;
    let notificationError: unknown;
    try {
      notify();
    } catch (error) {
      notificationFailed = true;
      notificationError = error;
    }
    const winner = pending === undefined ? undefined : await pending.catch(() => undefined);
    await withCredentialLock(input.storageKey, async () => {
      // Keep storage intact while waiting so the lock holder can rotate the
      // captured lineage; a different lineage belongs to a newer login.
      const stillCleared = slot.logoutGeneration === logoutGeneration;
      let storedRecord: ConnectStoredAuthCredentials | undefined;
      if (stillCleared && slot.persistenceEnabled && input.storage !== undefined) {
        try {
          const serialized = input.storage.getItem(input.storageKey);
          storedRecord = serialized === null ? undefined : parseStoredConnectCredentialRecord(serialized);
        } catch {
          slot.persistenceEnabled = false;
        }
      }
      const stored = storedRecord?.credentials;
      const storedIsLogoutLineage = lineageId !== undefined && storedRecord?.lineageId === lineageId;
      const storedTokenIsRotated = storedIsLogoutLineage &&
        stored?.refreshToken !== credentials?.refreshToken;
      const token = storedTokenIsRotated
        ? stored?.refreshToken
        : winner?.refreshToken ?? credentials?.refreshToken;
      if (stillCleared) {
        if (storedRecord === undefined || storedIsLogoutLineage) {
          persist(undefined);
        } else {
          slot.serializedCredentials = null;
          slot.lineageId = undefined;
        }
        slot.logoutGeneration = undefined;
      }
      if (token === undefined) return;
      try {
        await revokeConnectAuthSession(token, input.apiOptions);
      } catch (error) {
        // Already-expired/revoked credentials are logged out too. Other
        // failures remain observable even though local state is already gone.
        if (!(error instanceof SuperRareConnectApiError && error.status === 401)) throw error;
      }
    });
    if (notificationFailed) throw notificationError;
  };

  read();
  return {
    getSession: () => read()?.session,
    getCurrentSession,
    getReplacementGeneration: () => { read(); return slot.replacementGeneration; },
    commit,
    clear,
    logout,
    onChange(listener) {
      slot.listeners.add(listener);
      return () => { slot.listeners.delete(listener); };
    },
  };
}

function getCredentialSlot(storage: ConnectSessionStorage | undefined, storageKey: string): CredentialSlot {
  const createSlot = (): CredentialSlot => ({
    credentials: undefined,
    serializedCredentials: undefined,
    lineageId: undefined,
    generation: 0,
    replacementGeneration: 0,
    logoutGeneration: undefined,
    persistenceEnabled: storage !== undefined,
    refresh: undefined,
    listeners: new Set(),
  });
  if (storage === undefined) return createSlot();
  const slots = sharedSlots.get(storage) ?? new Map<string, CredentialSlot>();
  sharedSlots.set(storage, slots);
  const slot = slots.get(storageKey) ?? createSlot();
  slots.set(storageKey, slot);
  return slot;
}

function sameCredentials(left: ConnectAuthCredentials | undefined, right: ConnectAuthCredentials | undefined): boolean {
  return left === right || (
    left !== undefined && right !== undefined &&
    left.refreshToken === right.refreshToken && left.refreshExpiresAt === right.refreshExpiresAt &&
    left.session.sessionId === right.session.sessionId && left.session.expiresAt === right.session.expiresAt &&
    left.session.userId === right.session.userId && left.session.address === right.session.address
  );
}

function needsRefresh(session: ConnectSession): boolean {
  return Date.parse(session.expiresAt) <= Date.now() + refreshLeadMilliseconds;
}

async function withCredentialLock<T>(storageKey: string, operation: () => Promise<T>): Promise<T> {
  const navigator: unknown = Reflect.get(globalThis, 'navigator');
  if (typeof navigator === 'object' && navigator !== null) {
    const locks: unknown = Reflect.get(navigator, 'locks');
    if (isCredentialLockManager(locks)) {
      return await locks.request(`superrare.connect.credentials:${storageKey}`, operation);
    }
  }
  return await operation();
}

function isCredentialLockManager(value: unknown): value is {
  request: <T>(name: string, operation: () => Promise<T>) => Promise<T>;
} {
  return typeof value === 'object' && value !== null &&
    'request' in value && typeof value.request === 'function';
}
