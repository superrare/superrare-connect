import { z } from 'zod';
import { SuperRareConnectApiError } from './errors.js';

export type StudioApiOptions = { studioUrl: string; fetch?: typeof fetch };

const playerSchema = z.object({
  kind: z.enum(['profile', 'wallet', 'guest']),
  id: z.string().nullable(),
  handle: z.string().nullable(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  chainId: z.number().int().optional(),
});

const gameSessionResponseSchema = z.object({
  version: z.literal('1'),
  session: z.object({ id: z.string(), token: z.string().min(1), expiresAt: z.string() }),
  game: z.object({ id: z.string(), slug: z.string().nullable(), title: z.string(), buildId: z.string().nullable() }),
  player: playerSchema,
  defaultLeaderboard: z.object({
    id: z.string().optional(), key: z.literal('default'), seasonId: z.string().optional(), seasonKey: z.literal('all-time'),
  }),
  creditUse: z.object({ id: z.string(), status: z.string(), credits: z.number().int().positive(), token: z.string().min(1) }).optional(),
});

export type GameSessionStart = z.infer<typeof gameSessionResponseSchema>;

const creditBalanceSchema = z.object({
  accountId: z.string(), groupId: z.string(), chainId: z.number().int(), address: z.string(),
  balance: z.number().int(), reserved: z.number().int(), available: z.number().int(),
});
export type GameCreditBalance = z.infer<typeof creditBalanceSchema>;

const purchaseSchema = z.object({
  id: z.string(), accountId: z.string(), paymentConfigId: z.string(), chainId: z.number().int(),
  address: z.string(), treasuryAddress: z.string(), usdcAddress: z.string(), packPriceAtomic: z.string(),
  packCredits: z.number().int(), minBlock: z.string(), createdAt: z.string(), expiresAt: z.string(),
  transactionHash: z.string().nullable(), creditedAt: z.string().nullable(),
}).passthrough();
export type GameCreditPurchase = z.infer<typeof purchaseSchema>;

const leaderboardEntrySchema = z.object({
  rank: z.number().int(), scoreId: z.string(), score: z.string(), secondaryValue: z.string().nullable(),
  trustLevel: z.enum(['legacy_unverified', 'client_asserted', 'session_bound', 'server_verified', 'replay_verified']),
  achievedAt: z.string(), player: playerSchema, isCurrentPlayer: z.boolean(),
});
export type GameLeaderboardEntry = z.infer<typeof leaderboardEntrySchema>;

const leaderboardResponseSchema = z.object({
  version: z.literal('1'), leaderboard: z.record(z.string(), z.unknown()), season: z.record(z.string(), z.unknown()),
  entries: z.array(leaderboardEntrySchema), page: z.object({ hasMore: z.boolean(), nextCursor: z.string().nullable() }).optional(),
}).passthrough();
export type GameLeaderboard = z.infer<typeof leaderboardResponseSchema>;

const clientScoreResponseSchema = z.object({
  version: z.literal('1'), scoreId: z.string(), score: z.string(), idempotentReplay: z.boolean(),
}).passthrough();
export type ClientAssertedScoreResult = z.infer<typeof clientScoreResponseSchema>;

const serverRunResponseSchema = z.object({
  version: z.literal('1'), run: z.object({
    runId: z.string(), eventId: z.string(), engine: z.string(), engineVersion: z.string(), configDigest: z.string(),
    config: z.record(z.string(), z.unknown()), attemptNumber: z.number().int(), startedAt: z.string(), expiresAt: z.string(),
    idempotentReplay: z.boolean(), state: z.unknown(), webSocketUrl: z.string(),
  }),
});
export type ServerValidatedGameRun = z.infer<typeof serverRunResponseSchema>;

export async function requestStudioJson(input: StudioApiOptions & {
  path: string; method?: 'GET' | 'POST'; body?: unknown; authorization?: string; idempotencyKey?: string;
}): Promise<unknown> {
  const headers = new Headers({ Accept: 'application/json' });
  if (input.body !== undefined) headers.set('Content-Type', 'application/json');
  if (input.authorization !== undefined) headers.set('Authorization', input.authorization);
  if (input.idempotencyKey !== undefined) headers.set('Idempotency-Key', input.idempotencyKey);
  const response = await (input.fetch ?? globalThis.fetch)(`${input.studioUrl}${input.path}`, {
    method: input.method ?? 'GET', headers,
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
  if (!response.ok) {
    let message = response.statusText || 'Request failed';
    let code: string | undefined;
    try {
      const value: unknown = await response.clone().json();
      const parsed = z.object({ error: z.union([z.string(), z.object({ message: z.string(), code: z.string().optional() })]) }).safeParse(value);
      if (parsed.success) {
        message = typeof parsed.data.error === 'string' ? parsed.data.error : parsed.data.error.message;
        code = typeof parsed.data.error === 'string' ? undefined : parsed.data.error.code;
      }
    } catch { /* Keep the HTTP fallback. */ }
    throw new SuperRareConnectApiError(message, response.status, input.path, code);
  }
  return await response.json();
}

export const parseGameSessionStart = (value: unknown): GameSessionStart => gameSessionResponseSchema.parse(value);
export const parseCreditBalance = (value: unknown): GameCreditBalance => z.object({ balance: creditBalanceSchema }).parse(value).balance;
export const parsePurchase = (value: unknown): GameCreditPurchase => z.object({ purchase: purchaseSchema }).parse(value).purchase;
export const parseLeaderboard = (value: unknown): GameLeaderboard => leaderboardResponseSchema.parse(value);
export const parseMyBest = (value: unknown): GameLeaderboardEntry | null => z.object({ entry: leaderboardEntrySchema.nullable() }).parse(value).entry;
export const parseClientScore = (value: unknown): ClientAssertedScoreResult => clientScoreResponseSchema.parse(value);
export const parseServerRun = (value: unknown): ServerValidatedGameRun => serverRunResponseSchema.parse(value);
