import { z } from 'zod';

export const connectSessionSchema = z.object({
  sessionId: z.string().min(1),
  userId: z.string().min(1),
  address: z.string().min(1),
  expiresAt: z.string().min(1),
});

export type ConnectSession = z.infer<typeof connectSessionSchema>;

export type ConnectSessionStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

export function serializeConnectSession(session: ConnectSession): string {
  return JSON.stringify(session);
}

export function parseStoredConnectSession(serializedSession: string): ConnectSession | undefined {
  const parsedSession = parseJson(serializedSession);
  const result = connectSessionSchema.safeParse(parsedSession);
  return result.success ? result.data : undefined;
}

export function readConnectSessionFromStorage(
  storage: ConnectSessionStorage | undefined,
  storageKey: string,
): ConnectSession | undefined {
  const serializedSession = storage?.getItem(storageKey);
  return serializedSession === null || serializedSession === undefined
    ? undefined
    : parseStoredConnectSession(serializedSession);
}

export function writeConnectSessionToStorage(
  storage: ConnectSessionStorage | undefined,
  storageKey: string,
  session: ConnectSession,
): void {
  storage?.setItem(storageKey, serializeConnectSession(session));
}

export function removeConnectSessionFromStorage(
  storage: ConnectSessionStorage | undefined,
  storageKey: string,
): void {
  storage?.removeItem(storageKey);
}

function parseJson(value: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    return undefined;
  }
}
