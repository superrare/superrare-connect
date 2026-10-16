import { z } from 'zod';
import type { PendingConnectAuth } from './auth-flow-core.js';

export type ConnectDisplay = 'popup' | 'redirect';

export type ConnectNavigation = {
  assign: (url: string) => void;
};

const pendingConnectAuthSchema = z.object({
  intentId: z.string().min(1),
  state: z.string().min(1),
  expiresAt: z.string().min(1),
});

const pendingConnectRedirectIntentSchema = z.object({
  intentId: z.string().min(1),
});

/** The action intent a redirect started, read back on the return page. */
export type PendingConnectRedirectIntent = z.infer<typeof pendingConnectRedirectIntentSchema>;

export function parseStoredPendingConnectAuth(serialized: string): PendingConnectAuth | undefined {
  const parsed = pendingConnectAuthSchema.safeParse(parseJson(serialized));
  return parsed.success ? parsed.data : undefined;
}

export function parseStoredPendingConnectRedirectIntent(
  serialized: string,
): PendingConnectRedirectIntent | undefined {
  const parsed = pendingConnectRedirectIntentSchema.safeParse(parseJson(serialized));
  return parsed.success ? parsed.data : undefined;
}

function parseJson(serialized: string): unknown {
  try {
    return JSON.parse(serialized);
  } catch {
    return undefined;
  }
}
