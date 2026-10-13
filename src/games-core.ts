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
  constructor(readonly code: 'expired' | 'authorization_required' | 'invalid_origin' | 'invalid_authorization' | 'attempt_mismatch') {
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

const gameAuthorizationResponseSchema = z.object({
  version: z.literal('1'),
  authorization: gameAuthorizationSchema,
});

export function validateGameAuthorizationResponse(input: {
  value: unknown; appId: string; groupId: string; appOrigin: string;
  now: number; sessionExpiresAt: string; address: string;
}): { ok: true; authorization: GameAuthorization }
  | { ok: false; error: 'invalid_authorization' | 'expired' } {
  const parsed = gameAuthorizationResponseSchema.safeParse(input.value);
  if (!parsed.success) return { ok: false, error: 'invalid_authorization' };
  const authorization = parsed.data.authorization;
  const expiresAt = Date.parse(authorization.expiresAt);
  if (expiresAt <= input.now) return { ok: false, error: 'expired' };
  if (authorization.appId !== input.appId || authorization.groupId !== input.groupId
    || authorization.appOrigin !== input.appOrigin
    || authorization.address.toLowerCase() !== input.address.toLowerCase()
    || expiresAt > Math.min(Date.parse(input.sessionExpiresAt), input.now + 15 * 60_000)) {
    return { ok: false, error: 'invalid_authorization' };
  }
  return { ok: true, authorization };
}
