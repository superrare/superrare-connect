import { z } from 'zod';
import type { ConnectCurrentUser, ConnectIntentCreation } from './api.js';
import type { ConnectAuthCallbackParams } from './callback-core.js';
import type { ConnectSession } from './session-storage-core.js';

/**
 * Popup login: the hosted login page reports its auth callback to the opener
 * with a `postMessage` instead of redirecting. The message carries the same
 * one-time parameters the redirect callback would (`intentId`, `state`,
 * `code`); the SDK verifies them against the pending auth and exchanges the
 * code exactly like the redirect path — the wallet and user info are then
 * read from the exchanged session, never from the message itself.
 */

export const CONNECT_AUTH_CALLBACK_MESSAGE_TYPE = 'superrare-connect:auth-callback';

const connectAuthCallbackMessageSchema = z.object({
  type: z.literal(CONNECT_AUTH_CALLBACK_MESSAGE_TYPE),
  intentId: z.string().min(1),
  state: z.string().min(1),
  code: z.string().min(1),
});

export type ConnectAuthCallbackMessage = z.infer<typeof connectAuthCallbackMessageSchema>;

export type ConnectAuthCallbackMessageParseResult =
  | { ok: true; params: ConnectAuthCallbackParams }
  | { ok: false; error: 'origin_mismatch' | 'not_auth_callback' | 'malformed_message' };

/**
 * Validates a `message` event candidate for the popup login flow. Unrelated
 * messages (other extensions, other SDKs) resolve to `not_auth_callback` so
 * callers can ignore them silently; a message that claims to be an auth
 * callback but fails validation is reported distinctly.
 */
export function parseConnectAuthCallbackMessage(input: {
  data: unknown;
  origin: string;
  expectedOrigin: string;
}): ConnectAuthCallbackMessageParseResult {
  if (!isAuthCallbackShaped(input.data)) {
    return { ok: false, error: 'not_auth_callback' };
  }

  if (input.origin !== input.expectedOrigin) {
    return { ok: false, error: 'origin_mismatch' };
  }

  const result = connectAuthCallbackMessageSchema.safeParse(input.data);
  if (!result.success) {
    return { ok: false, error: 'malformed_message' };
  }

  return {
    ok: true,
    params: {
      intentId: result.data.intentId,
      state: result.data.state,
      code: result.data.code,
    },
  };
}

function isAuthCallbackShaped(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    data.type === CONNECT_AUTH_CALLBACK_MESSAGE_TYPE
  );
}

export type ConnectPopupLoginResult =
  | {
    /** The popup completed the login; the session is stored and active. */
    status: 'authenticated';
    session: ConnectSession;
    /** Profile of the signed-in user; `undefined` when the lookup fails. */
    user: ConnectCurrentUser | undefined;
  }
  | {
    /** The user closed the popup before completing the login. */
    status: 'cancelled';
  }
  | {
    /** The login intent expired while the popup was open. */
    status: 'expired';
  }
  | {
    /**
     * The popup could not be opened (blocked, or no message listener is
     * available); the flow fell back to the redirect login.
     */
    status: 'redirected';
    intent: ConnectIntentCreation;
  };

/**
 * Deadline for the popup watcher, in epoch milliseconds. An unparseable
 * `expiresAt` yields no deadline — the watcher then only ends on completion
 * or on the popup closing.
 */
export function getConnectPopupLoginDeadline(expiresAt: string): number | undefined {
  const deadline = Date.parse(expiresAt);
  return Number.isNaN(deadline) ? undefined : deadline;
}
