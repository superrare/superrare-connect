import * as z from 'zod/mini';

const tickSchema = z.int().check(z.gte(0));
const positiveIntegerSchema = tickSchema.check(z.gte(1));
const seedSchema = z.uint32();
export const targetConfigSchema = z.object({
  maxTicks: positiveIntegerSchema.check(z.lte(100_000)),
  roundTicks: positiveIntegerSchema.check(z.lte(100_000)),
}).check(z.refine((rules) => rules.maxTicks >= rules.roundTicks, 'maxTicks must be at least roundTicks'));
export type TargetConfig = z.infer<typeof targetConfigSchema>;

export const targetInputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('start') }),
  z.strictObject({ action: z.literal('hit'), targetId: positiveIntegerSchema }),
]);
export type TargetInput = z.infer<typeof targetInputSchema>;

export const targetStateSchema = z.object({
  tick: tickSchema,
  score: tickSchema,
  started: z.boolean(),
  gameOver: z.boolean(),
  startTick: z.nullable(tickSchema),
  rngState: seedSchema,
  rules: targetConfigSchema,
  target: z.object({
    id: positiveIntegerSchema,
    x: z.number().check(z.gte(0), z.lte(1)),
    y: z.number().check(z.gte(0), z.lte(1)),
  }),
}).check(z.refine((state) => state.started === (state.startTick !== null)
  && (state.startTick === null || state.startTick <= state.tick)
  && state.tick <= state.rules.maxTicks, 'Invalid target timeline'));
export type TargetState = z.infer<typeof targetStateSchema>;

const finalScoreSchema = z.union([
  tickSchema,
  z.pipe(z.pipe(z.string().check(z.regex(/^\d+$/)), z.transform(Number)), tickSchema),
]);
const finalResultSchema = z.looseObject({
  runId: z.optional(z.uuid()),
  score: finalScoreSchema,
  status: z.optional(z.string()),
});
const expiredResultSchema = z.looseObject({
  runId: z.optional(z.uuid()),
  score: z.optional(z.never()),
  status: z.literal('expired'),
});
export const targetSnapshotSchema = z.union([
  z.object({
    runId: z.uuid(),
    configDigest: z.string().check(z.regex(/^[0-9a-f]{64}$/i)),
    serverTick: tickSchema,
    inputSeq: tickSchema,
    inputTick: z.int().check(z.gte(-1)),
    expiresAt: z.string().check(z.refine((value) => Number.isFinite(Date.parse(value)), 'Invalid expiry')),
    state: targetStateSchema,
    result: z.nullable(z.union([finalResultSchema, expiredResultSchema])),
    status: z.optional(z.string()),
  }),
  z.object({ error: z.string(), serverTick: z.optional(tickSchema) }),
]);
export type TargetSnapshot = z.infer<typeof targetSnapshotSchema>;

function randomStep(rngState: number): number {
  let value = rngState;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return value >>> 0;
}

function nextTarget(rngState: number, id: number): { rngState: number; target: TargetState['target'] } {
  const xState = randomStep(rngState);
  const yState = randomStep(xState);
  return { rngState: yState, target: { id, x: xState / 0x1_0000_0000, y: yState / 0x1_0000_0000 } };
}

export function createRun(seed: unknown, config: unknown): TargetState {
  const validatedSeed = seedSchema.parse(seed);
  const rules = targetConfigSchema.parse(config);
  return {
    tick: 0,
    score: 0,
    started: false,
    gameOver: false,
    startTick: null,
    rules,
    ...nextTarget(validatedSeed || 0x9e3779b9, 1),
  };
}

export function advance(state: TargetState, serverTick: number): TargetState {
  if (!Number.isSafeInteger(serverTick) || serverTick < state.tick) {
    throw new Error('serverTick must be a nonnegative safe integer and must not move backwards');
  }
  if (state.gameOver || serverTick === state.tick) return state;
  const endTick = state.startTick === null
    ? state.rules.maxTicks
    : Math.min(state.rules.maxTicks, state.startTick + state.rules.roundTicks);
  const tick = Math.min(serverTick, endTick);
  return { ...state, tick, gameOver: tick >= endTick };
}

export function applyInput(state: TargetState, input: unknown, serverTick: number): TargetState {
  const current = advance(state, serverTick);
  if (current.gameOver) return current;
  const parsed = targetInputSchema.safeParse(input);
  if (!parsed.success) return current;
  if (parsed.data.action === 'start') {
    return current.started ? current : { ...current, started: true, startTick: current.tick };
  }
  if (!current.started || parsed.data.targetId !== current.target.id
    || current.score >= Number.MAX_SAFE_INTEGER - 1) return current;
  return {
    ...current,
    score: current.score + 1,
    ...nextTarget(current.rngState, current.target.id + 1),
  };
}

export function view(state: TargetState): TargetState {
  return state;
}

export function isFinished(state: TargetState): boolean {
  return state.gameOver;
}

export function score(state: TargetState): number {
  return state.score;
}

const savedKeySchema = z.string().check(z.regex(/^[A-Za-z0-9_-]+$/));
const savedDateSchema = z.string().check(z.refine((value) => Number.isFinite(Date.parse(value)), 'Invalid date'));
const savedTickSchema = z.int().check(z.gte(-1));
const savedRoundSchema = z.looseObject({
  version: z.union([z.literal(1), z.literal(2)]),
  key: savedKeySchema,
  phase: z.enum(['pending', 'ready', 'run_pending', 'connecting', 'playing', 'finalizing', 'submitting', 'completed', 'terminal']),
  score: z.optional(tickSchema),
  session: z.optional(z.looseObject({
    id: z.string().check(z.minLength(1)),
    token: z.string().check(z.minLength(1)),
    expiresAt: savedDateSchema,
  })),
  request: z.looseObject({
    idempotencyKey: z.string().check(z.minLength(1)),
    fingerprint: z.string().check(z.minLength(1)),
    expectedCredits: positiveIntegerSchema,
    metadata: z.optional(z.record(z.string(), z.unknown())),
  }),
  result: z.optional(finalResultSchema),
  completed: z.optional(z.boolean()),
  run: z.optional(z.looseObject({
    eventId: z.uuid(),
    key: savedKeySchema,
    runId: z.optional(z.uuid()),
    configDigest: z.optional(z.string().check(z.regex(/^[0-9a-f]{64}$/i))),
    startedAt: z.optional(savedDateSchema),
    expiresAt: z.optional(savedDateSchema),
    view: z.optional(targetStateSchema),
    serverTick: savedTickSchema,
    inputSeq: tickSchema,
    inputTick: savedTickSchema,
    pendingInputs: z.array(z.object({
      seq: positiveIntegerSchema,
      input: targetInputSchema,
      sent: z.optional(z.boolean()),
    })),
  })),
});
export type SavedRound = z.infer<typeof savedRoundSchema>;

export function parseSavedRound(value: unknown): SavedRound {
  return savedRoundSchema.parse(value);
}
