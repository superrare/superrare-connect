import { z } from 'zod';
import { pendingConnectAuthSchema, type PendingConnectAuth } from './auth-flow-core.js';

export type ConnectDisplay = 'popup' | 'redirect' | 'embed';

/**
 * An explicit `display` always wins. Without one, an `embed` adapter still
 * selects embedded display, kept only for clients written before `display`
 * accepted `'embed'`.
 */
export function resolveConnectDisplay(input: {
  display: ConnectDisplay | undefined;
  hasEmbedAdapter: boolean;
}): ConnectDisplay {
  return input.display ?? (input.hasEmbedAdapter ? 'embed' : 'popup');
}

export type ConnectNavigation = {
  assign: (url: string) => void;
};

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
