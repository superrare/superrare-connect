import { z } from 'zod';

const connectEmbedMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('superrare-connect:intent-status'),
    intentId: z.string().min(1),
    status: z.enum(['completed', 'cancelled', 'failed', 'expired']),
    transactionHash: z.string().optional(),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal('superrare-connect:embed-unavailable'),
    intentId: z.string().min(1),
  }),
]);

export type ConnectEmbedMessage = z.infer<typeof connectEmbedMessageSchema>;

export type ConnectEmbedMessageParseResult =
  | { ok: true; message: ConnectEmbedMessage }
  | {
    ok: false;
    error: 'origin_mismatch' | 'source_mismatch' | 'intent_mismatch' | 'malformed_message';
  };

export function appendConnectEmbedDisplay(url: string): string {
  const parsedUrl = new URL(url);
  parsedUrl.searchParams.set('display', 'embed');
  return parsedUrl.toString();
}

/** Terminal messages are reconciliation hints, not proof of payment. */
export function parseConnectEmbedMessage(input: {
  data: unknown;
  origin: string;
  source: unknown;
  expectedOrigin: string;
  expectedSource: unknown;
  intentId: string;
}): ConnectEmbedMessageParseResult {
  if (input.origin !== input.expectedOrigin) {
    return { ok: false, error: 'origin_mismatch' };
  }

  if (
    input.expectedSource === undefined ||
    input.expectedSource === null ||
    input.source !== input.expectedSource
  ) {
    return { ok: false, error: 'source_mismatch' };
  }

  const result = connectEmbedMessageSchema.safeParse(input.data);
  if (!result.success) {
    return { ok: false, error: 'malformed_message' };
  }

  if (result.data.intentId !== input.intentId) {
    return { ok: false, error: 'intent_mismatch' };
  }

  return { ok: true, message: result.data };
}

export class ConnectEmbedUnavailableError extends Error {
  readonly code = 'embed_unavailable';
  readonly intentId: string;

  constructor(intentId: string) {
    super('Embedded Connect is unavailable. Start a new popup intent to continue.');
    this.name = 'ConnectEmbedUnavailableError';
    this.intentId = intentId;
  }
}
