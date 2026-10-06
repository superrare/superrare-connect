import { z } from 'zod';

export const gameIdempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:~-]{7,127}$/);

export type GameStartFingerprintInput = {
  appId: string;
  groupId?: string;
  idempotencyKey: string;
  clientSessionId?: string;
  clientBuildId?: string;
  metadata?: Record<string, unknown>;
};

export function normalizeStudioUrl(studioUrl: string): string {
  const parsed = new URL(studioUrl);
  const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('studioUrl must be an origin without credentials, a path, query, or fragment.');
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback.has(parsed.hostname))) {
    throw new Error('studioUrl must use HTTPS, except for loopback development.');
  }
  return parsed.origin;
}

export function createGameStartFingerprint(input: GameStartFingerprintInput): string {
  // The fingerprint is an equality binding inside Studio's one-use consent,
  // not an authenticator (the random consent credential is). Keep it
  // synchronous so the approval popup can open inside the user's gesture.
  return [input.appId, input.groupId ?? 'free', input.idempotencyKey].join(':');
}

export function buildGameApprovalUrl(input: {
  studioUrl: string;
  appId: string;
  groupId: string;
  appOrigin: string;
  state: string;
  idempotencyKey: string;
  fingerprint: string;
}): string {
  const url = new URL('/connect/games/approve', normalizeStudioUrl(input.studioUrl));
  url.searchParams.set('appId', input.appId);
  url.searchParams.set('groupId', input.groupId);
  url.searchParams.set('appOrigin', input.appOrigin);
  url.searchParams.set('state', input.state);
  url.searchParams.set('idempotencyKey', input.idempotencyKey);
  url.searchParams.set('fingerprint', input.fingerprint);
  return url.toString();
}

export const GAME_CONSENT_MESSAGE_TYPE = 'superrare-connect:game-consent';

const gameConsentMessageSchema = z.object({
  type: z.literal(GAME_CONSENT_MESSAGE_TYPE),
  state: z.string().min(1),
  appId: z.string().min(1),
  groupId: z.string().min(1),
  consentId: z.string().min(1),
  consentToken: z.string().min(1),
  expiresAt: z.string().min(1),
});

export type GamePaidConsent = Omit<z.infer<typeof gameConsentMessageSchema>, 'type' | 'state'>;

export type GameConsentMessageResult =
  | { ok: true; consent: GamePaidConsent }
  | { ok: false; error: 'not_game_consent' | 'origin_mismatch' | 'state_mismatch' | 'binding_mismatch' | 'malformed_message' };

export function parseGameConsentMessage(input: {
  data: unknown;
  origin: string;
  expectedOrigin: string;
  expectedState: string;
  appId: string;
  groupId: string;
}): GameConsentMessageResult {
  if (!input.data || typeof input.data !== 'object' || !('type' in input.data)
    || input.data.type !== GAME_CONSENT_MESSAGE_TYPE) {
    return { ok: false, error: 'not_game_consent' };
  }
  if (input.origin !== input.expectedOrigin) return { ok: false, error: 'origin_mismatch' };
  const parsed = gameConsentMessageSchema.safeParse(input.data);
  if (!parsed.success) return { ok: false, error: 'malformed_message' };
  if (parsed.data.state !== input.expectedState) return { ok: false, error: 'state_mismatch' };
  if (parsed.data.appId !== input.appId || parsed.data.groupId !== input.groupId) {
    return { ok: false, error: 'binding_mismatch' };
  }
  const { type: _type, state: _state, ...consent } = parsed.data;
  return { ok: true, consent };
}
