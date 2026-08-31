import { z } from 'zod';
import type { CreateConnectIntentRequest, CreateConnectLoginIntentRequest } from './auth-flow-core.js';
import type { ConnectAuthCallbackParams } from './callback-core.js';
import { SuperRareConnectApiError } from './errors.js';
import {
  productCandidateListResponseSchema,
  productListResponseSchema,
  productResponseSchema,
  type AddProductVariantsParams,
  type Product,
  type ProductRecordPage,
  type ProductPage,
  type ProductUpdateParams,
  type ProductWriteParams,
  type RemoveProductVariantParams,
  type ReorderProductVariantsParams,
  type SetProductVariantVisibilityParams,
} from './product-flow-core.js';
import { connectSessionSchema, type ConnectSession } from './session-storage-core.js';
import {
  savedCartListResponseSchema,
  savedCartResponseSchema,
  type SavedCart,
  type SavedCartCreateParams,
  type SavedCartListParams,
  type SavedCartUpdateParams,
} from './saved-cart-flow-core.js';
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
// These paths are the account-scoped Cart Product contract. Keeping them in
// one adapter makes the SDK easy to align when Rare API's generated OpenAPI
// paths land; no hosted UI or connect-com import is needed here.
const cartProductsMinePath = '/v1/cart/products/mine';
const cartProductsPath = '/v1/cart/products';
const savedCartsPath = '/v1/cart/saved-carts';

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

const connectSellerCompletionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('product-manager'),
    productId: z.string().min(1).optional(),
  }),
  z.object({
    cartAddress: z.string().min(1),
    chainId: z.number().int().positive(),
    kind: z.literal('listing-manager'),
    listingDigests: z.array(z.string().min(1)).min(1),
    productId: z.string().min(1),
    rootDigest: z.string().min(1),
  }),
]);

const connectIntentPaymentSchema = z.object({
  email: z.string().min(1).optional(),
  method: z.literal('card').optional(),
  recipient: z.string().min(1).optional(),
  recipientBoundByCheckout: z.boolean().optional(),
});

const connectIntentSchema = z.object({
  intentId: z.string().min(1),
  type: z.enum(['login', 'seller-product-manager', 'seller-listing-manager', 'checkout', 'bid', 'buy', 'mint', 'offer', 'offer-accept', 'offer-cancel', 'settle']),
  status: z.enum(['pending', 'requires_user', 'processing', 'completed', 'failed', 'cancelled', 'expired']),
  initiatingOrigin: z.string().optional(),
  returnPath: z.string(),
  expiresAt: z.string().min(1),
  resolvedActionSnapshot: z.object({
    actionKey: z.string(),
    actionType: z.enum(['checkout', 'bid', 'buy', 'mint', 'offer', 'offer-accept', 'offer-cancel', 'settle']),
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
      'erc721-offer',
      'erc721-batch-offer',
    ]),
    terms: z.object({
      amount: z.string().optional(),
      available: z.boolean(),
      buyer: z.string().optional(),
      currency: z.string().optional(),
      expiry: z.string().optional(),
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
    cartAddress: z.string().optional(),
    chainId: z.number().int().positive().optional(),
    listingDigests: z.array(z.string()).optional(),
    paymentId: z.string().min(1).optional(),
    productId: z.string().optional(),
    referenceId: z.string().optional(),
    rootDigest: z.string().optional(),
    sellerCompletion: connectSellerCompletionSchema.optional(),
    sessionId: z.string().optional(),
    transactionHash: z.string().optional(),
  }).optional(),
  payment: connectIntentPaymentSchema.optional(),
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
    actionType: z.enum(['checkout', 'bid', 'buy', 'mint', 'offer', 'offer-accept', 'offer-cancel', 'settle']),
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
      'erc721-offer',
      'erc721-batch-offer',
    ]),
    terms: z.object({
      amount: z.string().optional(),
      available: z.boolean(),
      buyer: z.string().optional(),
      currency: z.string().optional(),
      expiry: z.string().optional(),
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
  signal?: AbortSignal;
} & ConnectAuthApiOptions): Promise<ConnectIntentCreation> {
  const body = await requestConnectApiJson({
    path: connectIntentsPath,
    method: 'POST',
    apiUrl: input.apiUrl,
    fetch: input.fetch,
    body: input.request,
    signal: input.signal,
  });
  const parsedResponse = createConnectIntentResponseSchema.safeParse(body);
  if (!parsedResponse.success) {
    throw new Error('Invalid Connect intent response.');
  }

  return parsedResponse.data.data;
}

export async function createConnectLoginIntent(input: {
  request: CreateConnectLoginIntentRequest;
  signal?: AbortSignal;
} & ConnectAuthApiOptions): Promise<ConnectIntentCreation> {
  return await createConnectIntent(input);
}

export async function getConnectIntent(input: {
  intentId: string;
  signal?: AbortSignal;
} & ConnectAuthApiOptions): Promise<ConnectIntent> {
  const body = await requestConnectApiJson({
    path: `${connectIntentsPath}/${encodeURIComponent(input.intentId)}`,
    method: 'GET',
    apiUrl: input.apiUrl,
    fetch: input.fetch,
    signal: input.signal,
  });
  const parsedResponse = getConnectIntentResponseSchema.safeParse(body);
  if (!parsedResponse.success) {
    throw new Error('Invalid Connect intent response.');
  }

  return parsedResponse.data.data;
}

export async function exchangeConnectAuthCode(
  params: ConnectAuthCallbackParams,
  options: ConnectAuthApiOptions & { signal?: AbortSignal } = {},
): Promise<ConnectSession> {
  const body = await requestConnectApiJson({
    path: connectAuthExchangePath,
    method: 'POST',
    apiUrl: options.apiUrl,
    fetch: options.fetch,
    body: params,
    signal: options.signal,
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
  signal?: AbortSignal;
} & ConnectAuthApiOptions): Promise<ConnectCurrentUser> {
  const body = await requestConnectApiJson({
    path: connectCurrentUserPath,
    method: 'GET',
    apiUrl: input.apiUrl,
    fetch: input.fetch,
    sessionId: input.sessionId,
    signal: input.signal,
  });
  const parsedResponse = getConnectCurrentUserResponseSchema.safeParse(body);
  if (!parsedResponse.success) {
    throw new Error('Invalid Connect current user response.');
  }

  return parsedResponse.data.data;
}

export async function listConnectProductsMine(input: {
  sessionId: string;
  page?: number;
  perPage?: number;
} & ConnectAuthApiOptions): Promise<ProductPage<Product>> {
  const body = await requestConnectApiJson({
    path: buildPagePath(cartProductsMinePath, input.page, input.perPage),
    method: 'GET',
    apiUrl: input.apiUrl,
    fetch: input.fetch,
    sessionId: input.sessionId,
  });
  const parsedResponse = productListResponseSchema.safeParse(body);
  if (!parsedResponse.success) {
    throw new Error('Invalid Connect Product list response.');
  }

  return parsedResponse.data;
}

export async function getConnectProductMine(input: {
  sessionId: string;
  productId: string;
} & ConnectAuthApiOptions): Promise<Product> {
  return await parseProductResponse(await requestConnectApiJson({
    path: `${cartProductsMinePath}/${encodeURIComponent(input.productId)}`,
    method: 'GET',
    apiUrl: input.apiUrl,
    fetch: input.fetch,
    sessionId: input.sessionId,
  }));
}

export async function createConnectProduct(input: {
  sessionId: string;
  product: ProductWriteParams;
} & ConnectAuthApiOptions): Promise<Product> {
  return await parseProductResponse(await requestConnectApiJson({
    path: cartProductsPath,
    method: 'POST',
    apiUrl: input.apiUrl,
    fetch: input.fetch,
    sessionId: input.sessionId,
    body: input.product,
  }));
}

export async function updateConnectProduct(input: {
  sessionId: string;
  productId: string;
  product: ProductUpdateParams;
} & ConnectAuthApiOptions): Promise<Product> {
  return await parseProductResponse(await requestConnectApiJson({
    path: `${cartProductsPath}/${encodeURIComponent(input.productId)}`,
    method: 'PATCH',
    apiUrl: input.apiUrl,
    fetch: input.fetch,
    sessionId: input.sessionId,
    body: input.product,
  }));
}

export async function publishConnectProduct(input: {
  sessionId: string;
  productId: string;
} & ConnectAuthApiOptions): Promise<Product> {
  return await postProductLifecycleAction(input, 'publish');
}

export async function archiveConnectProduct(input: {
  sessionId: string;
  productId: string;
} & ConnectAuthApiOptions): Promise<Product> {
  return await postProductLifecycleAction(input, 'archive');
}

export async function restoreConnectProductToDraft(input: {
  sessionId: string;
  productId: string;
} & ConnectAuthApiOptions): Promise<Product> {
  return await postProductLifecycleAction(input, 'restore-to-draft');
}

export async function listConnectProductCandidates(input: {
  sessionId: string;
  page?: number;
  perPage?: number;
  productId?: string;
} & ConnectAuthApiOptions): Promise<ProductRecordPage> {
  const body = await requestConnectApiJson({
    path: buildCandidatesPath(input),
    method: 'GET',
    apiUrl: input.apiUrl,
    fetch: input.fetch,
    sessionId: input.sessionId,
  });
  return parseProductCandidateList(body);
}

export async function addConnectProductVariants(input: {
  sessionId: string;
  product: AddProductVariantsParams;
} & ConnectAuthApiOptions): Promise<Product> {
  return parseProductResponse(await requestConnectApiJson({
    path: `${cartProductsPath}/${encodeURIComponent(input.product.productId)}/variants`,
    method: 'POST',
    apiUrl: input.apiUrl,
    fetch: input.fetch,
    sessionId: input.sessionId,
    body: { universalTokenIds: input.product.universalTokenIds },
  }));
}

export async function removeConnectProductVariant(input: {
  sessionId: string;
  variant: RemoveProductVariantParams;
} & ConnectAuthApiOptions): Promise<Product> {
  return parseProductResponse(await requestConnectApiJson({
    path: `${cartProductsPath}/${encodeURIComponent(input.variant.productId)}/variants/${encodeURIComponent(input.variant.variantId)}`,
    method: 'DELETE',
    apiUrl: input.apiUrl,
    fetch: input.fetch,
    sessionId: input.sessionId,
  }));
}

export async function reorderConnectProductVariants(input: {
  sessionId: string;
  variants: ReorderProductVariantsParams;
} & ConnectAuthApiOptions): Promise<Product> {
  return parseProductResponse(await requestConnectApiJson({
    path: `${cartProductsPath}/${encodeURIComponent(input.variants.productId)}/variants/order`,
    method: 'PATCH',
    apiUrl: input.apiUrl,
    fetch: input.fetch,
    sessionId: input.sessionId,
    body: { variantIds: input.variants.variantIds },
  }));
}

export async function setConnectProductVariantVisibility(input: {
  sessionId: string;
  variant: SetProductVariantVisibilityParams;
} & ConnectAuthApiOptions): Promise<Product> {
  return parseProductResponse(await requestConnectApiJson({
    path: `${cartProductsPath}/${encodeURIComponent(input.variant.productId)}/variants/${encodeURIComponent(input.variant.variantId)}`,
    method: 'PATCH',
    apiUrl: input.apiUrl,
    fetch: input.fetch,
    sessionId: input.sessionId,
    body: { isHidden: input.variant.isHidden },
  }));
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

export async function listConnectSavedCarts(input: {
  sessionId: string;
} & SavedCartListParams & ConnectAuthApiOptions): Promise<{
  data: SavedCart[];
  hasNextPage: boolean;
}> {
  const body = await requestConnectApiJson({
    path: buildPagePath(savedCartsPath, input.page, input.perPage),
    method: 'GET',
    apiUrl: input.apiUrl,
    fetch: input.fetch,
    sessionId: input.sessionId,
  });
  return savedCartListResponseSchema.parse(body);
}

export async function getConnectSavedCart(input: {
  sessionId: string;
  cartId: string;
} & ConnectAuthApiOptions): Promise<SavedCart> {
  return await parseSavedCartResponse(await requestConnectApiJson({
    path: `${savedCartsPath}/${encodeURIComponent(input.cartId)}`,
    method: 'GET',
    apiUrl: input.apiUrl,
    fetch: input.fetch,
    sessionId: input.sessionId,
  }));
}

export async function createConnectSavedCart(input: {
  sessionId: string;
  cart: SavedCartCreateParams;
} & ConnectAuthApiOptions): Promise<SavedCart> {
  return await parseSavedCartResponse(await requestConnectApiJson({
    path: savedCartsPath,
    method: 'POST',
    apiUrl: input.apiUrl,
    fetch: input.fetch,
    sessionId: input.sessionId,
    body: input.cart,
  }));
}

export async function updateConnectSavedCart(input: {
  sessionId: string;
  cart: SavedCartUpdateParams;
} & ConnectAuthApiOptions): Promise<SavedCart> {
  return await parseSavedCartResponse(await requestConnectApiJson({
    path: `${savedCartsPath}/${encodeURIComponent(input.cart.cartId)}`,
    method: 'PATCH',
    apiUrl: input.apiUrl,
    fetch: input.fetch,
    sessionId: input.sessionId,
    body: { purchaseCurrency: input.cart.purchaseCurrency },
  }));
}

export async function deleteConnectSavedCart(input: {
  sessionId: string;
  cartId: string;
} & ConnectAuthApiOptions): Promise<SavedCart> {
  return await parseSavedCartResponse(await requestConnectApiJson({
    path: `${savedCartsPath}/${encodeURIComponent(input.cartId)}`,
    method: 'DELETE',
    apiUrl: input.apiUrl,
    fetch: input.fetch,
    sessionId: input.sessionId,
  }));
}

export async function putConnectSavedCartItem(input: {
  sessionId: string;
  cartId: string;
  listingDigest: string;
  quantity: string;
} & ConnectAuthApiOptions): Promise<SavedCart> {
  return await parseSavedCartResponse(await requestConnectApiJson({
    path: `${savedCartsPath}/${encodeURIComponent(input.cartId)}/items/${encodeURIComponent(input.listingDigest)}`,
    method: 'PUT',
    apiUrl: input.apiUrl,
    fetch: input.fetch,
    sessionId: input.sessionId,
    body: { quantity: input.quantity },
  }));
}

export async function removeConnectSavedCartItem(input: {
  sessionId: string;
  cartId: string;
  listingDigest: string;
} & ConnectAuthApiOptions): Promise<SavedCart> {
  return await parseSavedCartResponse(await requestConnectApiJson({
    path: `${savedCartsPath}/${encodeURIComponent(input.cartId)}/items/${encodeURIComponent(input.listingDigest)}`,
    method: 'DELETE',
    apiUrl: input.apiUrl,
    fetch: input.fetch,
    sessionId: input.sessionId,
  }));
}

async function parseSavedCartResponse(body: unknown): Promise<SavedCart> {
  return savedCartResponseSchema.parse(body).data;
}

function parseProductResponse(body: unknown): Product {
  const parsedResponse = productResponseSchema.safeParse(body);
  if (!parsedResponse.success) {
    throw new Error('Invalid Connect Product response.');
  }

  return parsedResponse.data.data;
}

function parseProductCandidateList(body: unknown): ProductRecordPage {
  const parsedResponse = productCandidateListResponseSchema.safeParse(body);
  if (!parsedResponse.success) {
    throw new Error('Invalid Connect Product candidate list response.');
  }

  return parsedResponse.data;
}

async function postProductLifecycleAction(input: {
  sessionId: string;
  productId: string;
} & ConnectAuthApiOptions, action: 'publish' | 'archive' | 'restore-to-draft'): Promise<Product> {
  return parseProductResponse(await requestConnectApiJson({
    path: `${cartProductsPath}/${encodeURIComponent(input.productId)}/${action === 'restore-to-draft' ? 'restore' : action}`,
    method: 'POST',
    apiUrl: input.apiUrl,
    fetch: input.fetch,
    sessionId: input.sessionId,
  }));
}

function buildPagePath(path: string, page = 1, perPage = 20): string {
  const query = new URLSearchParams({
    page: String(page),
    perPage: String(perPage),
  });
  return `${path}?${query.toString()}`;
}

function buildCandidatesPath(input: {
  page?: number;
  perPage?: number;
  productId?: string;
}): string {
  const query = new URLSearchParams({
    page: String(input.page ?? 1),
    perPage: String(input.perPage ?? 20),
  });
  if (input.productId !== undefined) {
    query.set('productId', input.productId);
  }
  return `${cartProductsPath}/variant-candidates?${query.toString()}`;
}

async function requestConnectApiJson(input: {
  apiUrl?: string;
  fetch?: typeof fetch;
  path: string;
  method: 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';
  body?: unknown;
  sessionId?: string;
  signal?: AbortSignal;
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
  method: 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';
  body?: unknown;
  sessionId?: string;
  signal?: AbortSignal;
}): RequestInit {
  return {
    method: input.method,
    headers: buildRequestHeaders(input.sessionId),
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
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
