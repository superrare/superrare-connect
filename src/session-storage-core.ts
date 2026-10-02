import { z } from 'zod';

export const connectSessionSchema = z.object({
  sessionId: z.string().min(1),
  userId: z.string().min(1),
  address: z.string().min(1),
  expiresAt: z.string().datetime(),
});

export type ConnectSession = z.infer<typeof connectSessionSchema>;

export const connectAuthCredentialsSchema = z.object({
  session: connectSessionSchema,
  refreshToken: z.string().min(1).max(512),
  refreshExpiresAt: z.string().datetime(),
});

export type ConnectAuthCredentials = z.infer<typeof connectAuthCredentialsSchema>;

export type ConnectSessionStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

export function serializeConnectCredentials(credentials: ConnectAuthCredentials): string {
  return JSON.stringify(credentials);
}

export function parseStoredConnectCredentials(
  serializedCredentials: string,
): ConnectAuthCredentials | undefined {
  const parsedCredentials = parseJson(serializedCredentials);
  const result = connectAuthCredentialsSchema.safeParse(parsedCredentials);
  return result.success ? result.data : undefined;
}

export function readConnectCredentialsFromStorage(
  storage: ConnectSessionStorage | undefined,
  storageKey: string,
): ConnectAuthCredentials | undefined {
  const serializedCredentials = storage?.getItem(storageKey);
  return serializedCredentials === null || serializedCredentials === undefined
    ? undefined
    : parseStoredConnectCredentials(serializedCredentials);
}

export function writeConnectCredentialsToStorage(
  storage: ConnectSessionStorage | undefined,
  storageKey: string,
  credentials: ConnectAuthCredentials,
): void {
  storage?.setItem(storageKey, serializeConnectCredentials(credentials));
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
