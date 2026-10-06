import { z } from 'zod';

export const gameIdempotencyKeySchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:~-]{7,127}$/);
const identifierSchema = z.string().min(1);
export const gamePaidConsentSchema = z.object({
  appId: identifierSchema, groupId: identifierSchema, consentId: identifierSchema,
  consentToken: identifierSchema, expiresAt: z.iso.datetime({ offset: true }), credits: z.number().int().positive().optional(),
});
export type GamePaidConsent = z.infer<typeof gamePaidConsentSchema>;
export const gameAuthorizationSchema = z.object({
  appId: identifierSchema, groupId: identifierSchema, appOrigin: z.url(),
  authorizationToken: identifierSchema, expiresAt: z.iso.datetime({ offset: true }), address: identifierSchema,
});
export type GameAuthorization = z.infer<typeof gameAuthorizationSchema>;
export const gameCreditTermsSchema = z.object({
  appId: identifierSchema, groupId: identifierSchema, appOrigin: z.url(), credits: z.number().int().positive(), title: z.string(),
});
export type GameCreditTerms = z.infer<typeof gameCreditTermsSchema>;
export const inlineConsentResponseSchema = z.object({ version: z.literal('1'), consent: z.object({
  id: identifierSchema, appId: identifierSchema, groupId: identifierSchema, consentToken: identifierSchema,
  credits: z.number().int().positive(), expiresAt: z.iso.datetime({ offset: true }),
}) });
export const gameTermsResponseSchema = z.object({ version: z.literal('1'), terms: gameCreditTermsSchema });
export const gameConsentRequestSchema = z.object({
  idempotencyKey: gameIdempotencyKeySchema, fingerprint: z.string().min(1).max(256), expectedCredits: z.number().int().positive(),
  clientSessionId: z.string().optional(), clientBuildId: z.string().optional(), metadata: z.record(z.string(), z.unknown()).optional(),
});
export type GameConsentRequest = z.infer<typeof gameConsentRequestSchema>;
export const gamePendingAttemptSchema = z.object({ request: gameConsentRequestSchema, consent: gamePaidConsentSchema.optional() });
export type GamePendingAttempt = z.infer<typeof gamePendingAttemptSchema>;

export class GameConnectionError extends Error {
  constructor(readonly code: 'cancelled' | 'expired' | 'authorization_required' | 'invalid_origin' | 'invalid_message' | 'attempt_mismatch') {
    super(`Game connection: ${code}.`);
    this.name = 'GameConnectionError';
  }
}

export function normalizeStudioUrl(studioUrl: string): string {
  const parsed = new URL(studioUrl);
  const loopback: Record<string, true | undefined> = { localhost: true, '127.0.0.1': true, '[::1]': true };
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error('studioUrl must be an origin without credentials, a path, query, or fragment.');
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback[parsed.hostname] === true)) {
    throw new Error('studioUrl must use HTTPS, except for loopback development.');
  }
  return parsed.origin;
}

export function buildGameAuthorizationUrl(input: {
  studioUrl: string; appId: string; groupId: string; appOrigin: string; state: string;
}): string {
  const url = new URL('/connect/games/authorize', normalizeStudioUrl(input.studioUrl));
  url.searchParams.set('appId', input.appId);
  url.searchParams.set('groupId', input.groupId);
  url.searchParams.set('appOrigin', input.appOrigin);
  url.searchParams.set('state', input.state);
  return url.toString();
}

const authorizationMessageSchema = gameAuthorizationSchema.extend({
  type: z.literal('superrare-connect:game-authorization'), state: z.string().min(16).max(256),
});
const authorizationBindingSchema = authorizationMessageSchema.pick({
  type: true, state: true, appId: true, groupId: true, appOrigin: true,
});
const cancelledMessageSchema = z.object({
  type: z.literal('superrare-connect:game-authorization-cancelled'), state: z.string().min(16).max(256),
  appId: identifierSchema, groupId: identifierSchema,
});
export function parseGameAuthorizationMessage(input: {
  data: unknown; origin: string; expectedOrigin: string; expectedState: string;
  appId: string; groupId: string; appOrigin: string; now: number;
}): { status: 'ignored' } | { status: 'cancelled' } | { status: 'expired' } | { status: 'invalid_message' } | { status: 'authorized'; authorization: GameAuthorization } {
  if (input.origin !== input.expectedOrigin) return { status: 'ignored' };
  const cancelled = cancelledMessageSchema.safeParse(input.data);
  if (cancelled.success && cancelled.data.state === input.expectedState && cancelled.data.appId === input.appId && cancelled.data.groupId === input.groupId) {
    return { status: 'cancelled' };
  }
  const binding = authorizationBindingSchema.safeParse(input.data);
  if (!binding.success || binding.data.state !== input.expectedState || binding.data.appId !== input.appId
    || binding.data.groupId !== input.groupId || binding.data.appOrigin !== input.appOrigin) return { status: 'ignored' };
  const result = authorizationMessageSchema.safeParse(input.data);
  if (!result.success) return { status: 'invalid_message' };
  if (Date.parse(result.data.expiresAt) <= input.now) return { status: 'expired' };
  const { type: _type, state: _state, ...authorization } = result.data;
  return { status: 'authorized', authorization };
}
