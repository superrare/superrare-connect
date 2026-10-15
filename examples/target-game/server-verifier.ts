import * as z from 'zod/mini';
import {
  advance, applyInput, createRun, isFinished, score,
  targetStateSchema, view,
} from './target-engine.js';
import type { TargetState } from './target-engine.js';

const serverTickSchema = z.int().check(z.gte(0));
const requestSchema = z.discriminatedUnion('op', [
  z.strictObject({ version: z.literal(1), op: z.literal('createRun'), seed: z.unknown(), config: z.unknown() }),
  z.strictObject({ version: z.literal(1), op: z.literal('advance'), state: targetStateSchema, serverTick: serverTickSchema }),
  z.strictObject({ version: z.literal(1), op: z.literal('applyInput'), state: targetStateSchema, input: z.record(z.string(), z.unknown()), serverTick: serverTickSchema }),
  z.strictObject({ version: z.literal(1), op: z.literal('view'), state: targetStateSchema }),
  z.strictObject({ version: z.literal(1), op: z.literal('isFinished'), state: targetStateSchema }),
  z.strictObject({ version: z.literal(1), op: z.literal('score'), state: targetStateSchema }),
]);

async function handle(request: Request): Promise<Response> {
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1') {
    return new Response('Not found', { status: 404 });
  }
  try {
    const raw: unknown = await request.json();
    const payload = requestSchema.parse(raw);
    let result: TargetState | boolean | number;
    switch (payload.op) {
      case 'createRun':
        result = createRun(payload.seed, payload.config);
        break;
      case 'advance':
        result = advance(payload.state, payload.serverTick);
        break;
      case 'applyInput':
        result = applyInput(payload.state, payload.input, payload.serverTick);
        break;
      case 'view':
        result = view(payload.state);
        break;
      case 'isFinished':
        result = isFinished(payload.state);
        break;
      case 'score':
        result = score(payload.state);
        break;
    }
    return Response.json({ version: 1, result });
  } catch (error: unknown) {
    return Response.json({ error: error instanceof Error ? error.message : 'Invalid verifier request' }, { status: 400 });
  }
}

export default { fetch: handle };
