import { z } from 'zod';
import type { CreateConnectIntentRequest, CreateConnectLoginIntentRequest } from './auth-flow-core.js';
import type { ConnectAuthCallbackParams } from './callback-core.js';
import { SuperRareConnectApiError } from './errors.js';
import { connectSessionSchema, type ConnectSession } from './session-storage-core.js';
import type { ConnectCheckoutStatus, ConnectIntent } from './status-core.js';

export type ConnectAuthApiOptions = {
  apiUrl?: string;
  fetch?: typeof fetch;
};

const DEFAULT_RARE_API_URL = 'https://api.superrare.com';
const connectIntentsPath = '/v1/connect/intents';
const connectAuthExchangePath = '/v1/connect/auth/exchange';
const connectSessionPath = '/v1/connect/session';
const connectCurrentUserPath = '/v1/connect/users/me';

export type ConnectIntentCreation = {
  intentId: string;
  url: string;
  expiresAt: string;
};

export type ConnectSessionState = {
  authenticated: boolean;
  session?: ConnectSession;
};

export type ConnectCurrentUser = {
  address: string;
  username: string | null;
  fullName: string | null;
  avatarUri: string | null;
};

const exchangeConnectAuthResponseSchema = z.object({
  data: z.object({
    session: connectSessionSchema,
  }),
});

const createConnectIntentResponseSchema = z.object({
  data: z.object({
    intentId: z.string().min(1),
    url: z.string().min(1),
    expiresAt: z.string().min(1),
  }),
});

const getConnectSessionResponseSchema = z.object({
  data: z.object({
    authenticated: z.boolean(),
    session: connectSessionSchema.optional(),
  }),
});

const getConnectCurrentUserResponseSchema = z.object({
  data: z.object({
    address: z.string().min(1),
    username: z.string().nullable(),
    fullName: z.string().nullable(),
    avatarUri: z.string().nullable(),
  }),
});

const connectIntentSchema = z.object({
  intentId: z.string().min(1),
  type: z.enum(['login', 'checkout', 'bid', 'buy', 'mint']),
  status: z.enum(['pending', 'requires_user', 'processing', 'completed', 'failed', 'cancelled', 'expired']),
  initiatingOrigin: z.string().optional(),
  returnPath: z.string(),
  expiresAt: z.string().min(1),
  resolvedActionSnapshot: z.object({
    actionKey: z.string(),
    actionType: z.enum(['checkout', 'bid', 'buy', 'mint']),
    resolvedAt: z.string(),
    targetKind: z.enum([
      'erc721-direct-listing',
      'erc721-batch-listing',
      'erc1155-listing',
      'erc721-reserve-auction',
      'erc721-batch-reserve-auction',
      'erc721-release',
      'erc1155-release',
      'erc1155-checkout',
    ]),
    terms: z.object({
      amount: z.string().optional(),
      available: z.boolean(),
      currency: z.string().optional(),
      marketplace: z.string().optional(),
      merkleRoot: z.string().optional(),
      merkleProof: z.array(z.string()).optional(),
      price: z.string().optional(),
      quantity: z.string().optional(),
      quantityAvailable: z.string().optional(),
      seller: z.string().optional(),
      unitPrice: z.string().optional(),
    }),
  }).optional(),
  result: z.object({
    approvalTxHash: z.string().optional(),
    referenceId: z.string().optional(),
    sessionId: z.string().optional(),
    transactionHash: z.string().optional(),
  }).optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }).optional(),
});

const getConnectIntentResponseSchema = z.object({
  data: connectIntentSchema,
});

const connectCheckoutStatusSchema = z.object({
  sessionId: z.string().min(1),
  status: z.enum(['pending', 'processing', 'completed', 'failed', 'cancelled', 'expired']),
  initiatingOrigin: z.string().optional(),
  returnPath: z.string().optional(),
  intentId: z.string().optional(),
  expiresAt: z.string().optional(),
  resolvedActionSnapshot: z.object({
    actionKey: z.string(),
    actionType: z.enum(['checkout', 'bid', 'buy', 'mint']),
    resolvedAt: z.string(),
    targetKind: z.enum([
      'erc721-direct-listing',
      'erc721-batch-listing',
      'erc1155-listing',
      'erc721-reserve-auction',
      'erc721-batch-reserve-auction',
      'erc721-release',
      'erc1155-release',
      'erc1155-checkout',
    ]),
    terms: z.object({
      amount: z.string().optional(),
      available: z.boolean(),
      currency: z.string().optional(),
      marketplace: z.string().optional(),
      merkleRoot: z.string().optional(),
      merkleProof: z.array(z.string()).optional(),
      price: z.string().optional(),
      quantity: z.string().optional(),
      quantityAvailable: z.string().optional(),
      seller: z.string().optional(),
      unitPrice: z.string().optional(),
    }),
  }).optional(),
  approvalTxHash: z.string().optional(),
  transactionHash: z.string().optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }).optional(),
});

const getConnectCheckoutStatusResponseSchema = z.object({
  data: connectCheckoutStatusSchema,
});

export async function createConnectIntent(input: {
  request: CreateConnectIntentRequest;
} & ConnectAuthApiOptions): Promise<ConnectIntentCreation> {
  const body = await requestConnectApiJson({
    path: connectIntentsPath,
    method: 'POST',
    apiUrl: input.apiUrl,
    fetch: input.fetch,
    body: input.request,
  });
  const parsedResponse = createConnectIntentResponseSchema.safeParse(body);
  if (!parsedResponse.success) {
    throw new Error('Invalid Connect intent response.');
  }

  return parsedResponse.data.data;
}

export async function createConnectLoginIntent(input: {
  request: CreateConnectLoginIntentRequest;
} & ConnectAuthApiOptions): Promise<ConnectIntentCreation> {
  return await createConnectIntent(input);
}

export async function getConnectIntent(input: {
  intentId: string;
} & ConnectAuthApiOptions): Promise<ConnectIntent> {
  const body = await requestConnectApiJson({
    path: `${connectIntentsPath}/${encodeURIComponent(input.intentId)}`,
    method: 'GET',
    apiUrl: input.apiUrl,
    fetch: input.fetch,
  });
  const parsedResponse = getConnectIntentResponseSchema.safeParse(body);
  if (!parsedResponse.success) {
    throw new Error('Invalid Connect intent response.');
  }

  return parsedResponse.data.data;
}

export async function exchangeConnectAuthCode(
  params: ConnectAuthCallbackParams,
  options: ConnectAuthApiOptions = {},
): Promise<ConnectSession> {
  const body = await requestConnectApiJson({
    path: connectAuthExchangePath,
    method: 'POST',
    apiUrl: options.apiUrl,
    fetch: options.fetch,
    body: params,
  });
  const parsedResponse = exchangeConnectAuthResponseSchema.safeParse(body);
  if (!parsedResponse.success) {
    throw new Error('Invalid Connect auth exchange response.');
  }

  return parsedResponse.data.data.session;
}

export async function getConnectSession(input: {
  sessionId?: string;
} & ConnectAuthApiOptions): Promise<ConnectSessionState> {
  const body = await requestConnectApiJson({
    path: connectSessionPath,
    method: 'GET',
    apiUrl: input.apiUrl,
    fetch: input.fetch,
    sessionId: input.sessionId,
  });
  const parsedResponse = getConnectSessionResponseSchema.safeParse(body);
  if (!parsedResponse.success) {
    throw new Error('Invalid Connect session response.');
  }

  return parsedResponse.data.data;
}

export async function getConnectCurrentUser(input: {
  sessionId: string;
} & ConnectAuthApiOptions): Promise<ConnectCurrentUser> {
  const body = await requestConnectApiJson({
    path: connectCurrentUserPath,
    method: 'GET',
    apiUrl: input.apiUrl,
    fetch: input.fetch,
    sessionId: input.sessionId,
  });
  const parsedResponse = getConnectCurrentUserResponseSchema.safeParse(body);
  if (!parsedResponse.success) {
    throw new Error('Invalid Connect current user response.');
  }

  return parsedResponse.data.data;
}

export async function getConnectCheckoutStatus(input: {
  sessionId: string;
} & ConnectAuthApiOptions): Promise<ConnectCheckoutStatus> {
  const body = await requestConnectApiJson({
    path: `/v1/connect/checkout/${encodeURIComponent(input.sessionId)}`,
    method: 'GET',
    apiUrl: input.apiUrl,
    fetch: input.fetch,
  });
  const parsedResponse = getConnectCheckoutStatusResponseSchema.safeParse(body);
  if (!parsedResponse.success) {
    throw new Error('Invalid Connect checkout status response.');
  }

  return parsedResponse.data.data;
}

async function requestConnectApiJson(input: {
  apiUrl?: string;
  fetch?: typeof fetch;
  path: string;
  method: 'GET' | 'POST';
  body?: unknown;
  sessionId?: string;
}): Promise<unknown> {
  const fetchImplementation = input.fetch ?? globalThis.fetch;
  const response = await fetchImplementation(
    buildRareApiUrl(input.apiUrl, input.path),
    buildRequestInit(input),
  );

  if (!response.ok) {
    throw await buildConnectApiError(response, input.path);
  }

  return await response.json();
}

function buildRequestInit(input: {
  method: 'GET' | 'POST';
  body?: unknown;
  sessionId?: string;
}): RequestInit {
  return {
    method: input.method,
    headers: buildRequestHeaders(input.sessionId),
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  };
}

function buildRequestHeaders(sessionId: string | undefined): Headers {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (sessionId !== undefined) {
    headers.set('Authorization', `Bearer ${sessionId}`);
  }
  return headers;
}

function buildRareApiUrl(apiUrl: string | undefined, path: string): string {
  const baseUrl = apiUrl?.trim() === '' || apiUrl === undefined
    ? DEFAULT_RARE_API_URL
    : apiUrl.trim().replace(/\/+$/, '');
  return `${baseUrl}${path}`;
}

async function buildConnectApiError(
  response: Response,
  path: string,
): Promise<SuperRareConnectApiError> {
  const message = await readConnectApiErrorMessage(response);
  const fallback = response.statusText.length > 0 ? response.statusText : 'Request failed';
  return new SuperRareConnectApiError(message ?? fallback, response.status, path);
}

async function readConnectApiErrorMessage(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.clone().json();
    const parsed = z.object({ error: z.string() }).safeParse(body);
    return parsed.success ? parsed.data.error : undefined;
  } catch {
    return undefined;
  }
}
