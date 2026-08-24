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

export type ConnectHostedUrlResult =
  | { ok: true; origin: string }
  | { ok: false; error: 'unparseable' | 'unsupported_protocol' };

const loopbackHostnames = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Validates a hosted URL before the SDK navigates a window to it. The URL
 * comes from Rare API, but this is the last boundary before an actual
 * navigation: a `javascript:` or `data:` URL would execute in the opened
 * window, and a plaintext `http:` page could be swapped by an on-path
 * attacker — and its origin would then be the one the SDK trusts for the
 * auth callback. Plain `http:` is therefore allowed only for loopback hosts
 * (local development), mirroring Rare API's own origin policy.
 */
export function resolveConnectHostedUrl(url: string): ConnectHostedUrlResult {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { ok: false, error: 'unparseable' };
  }

  if (parsedUrl.protocol === 'https:') {
    return { ok: true, origin: parsedUrl.origin };
  }

  if (parsedUrl.protocol === 'http:' && loopbackHostnames.has(parsedUrl.hostname)) {
    return { ok: true, origin: parsedUrl.origin };
  }

  return { ok: false, error: 'unsupported_protocol' };
}
