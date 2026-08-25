import { describe, expect, it, vi } from 'vitest';
import {
  createConnectIntent,
  createConnectLoginIntent,
  createConnectProduct,
  getConnectCheckoutStatus,
  getConnectCurrentUser,
  getConnectProductMine,
  getConnectIntent,
  getConnectSession,
  listConnectProductCandidates,
  listConnectProductsMine,
  addConnectProductVariants,
  restoreConnectProductToDraft,
  publishConnectProduct,
} from '../src/api.js';
import type { ConnectErc1155CheckoutTarget } from '../src/auth-flow-core.js';

const checkoutTarget: ConnectErc1155CheckoutTarget = {
  kind: 'erc1155-checkout',
  chainId: 1,
  items: [
    {
      kind: 'listing',
      contract: '0x1234567890123456789012345678901234567890',
      seller: '0x2222222222222222222222222222222222222222',
      tokenId: '123',
      quantity: '2',
      expected: { currency: 'ETH', unitPrice: '1.2' },
    },
  ],
};

describe('Connect API client', () => {
  it('creates login intents', async () => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);

      expect(request.method).toBe('POST');
      expect(request.url).toBe('https://rare-api.test/v1/connect/intents');
      expect(await request.json()).toEqual({
        action: { type: 'login' },
        returnPath: '/account',
        state: 'state_123',
        initiatingOrigin: 'https://artist.example',
      });

      return jsonResponse({
        data: {
          intentId: 'connect_intent_123',
          url: 'https://connect.superrare.test/login?intentId=connect_intent_123',
          expiresAt: '2026-06-22T00:00:00.000Z',
        },
      });
    });

    await expect(createConnectLoginIntent({
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
      request: {
        action: { type: 'login' },
        returnPath: '/account',
        state: 'state_123',
        initiatingOrigin: 'https://artist.example',
      },
    })).resolves.toEqual({
      intentId: 'connect_intent_123',
      url: 'https://connect.superrare.test/login?intentId=connect_intent_123',
      expiresAt: '2026-06-22T00:00:00.000Z',
    });
  });

  it('creates checkout intents through the generic intent client', async () => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);

      expect(request.method).toBe('POST');
      expect(request.url).toBe('https://rare-api.test/v1/connect/intents');
      expect(await request.json()).toEqual({
        action: {
          type: 'checkout',
          target: checkoutTarget,
        },
        returnPath: '/thanks',
        state: 'state_123',
      });

      return jsonResponse({
        data: {
          intentId: 'connect_intent_checkout',
          url: 'https://connect.superrare.test/checkout/connect_checkout_session_123?intentId=connect_intent_checkout',
          expiresAt: '2026-06-22T00:00:00.000Z',
        },
      });
    });

    await expect(createConnectIntent({
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
      request: {
        action: {
          type: 'checkout',
          target: checkoutTarget,
        },
        returnPath: '/thanks',
        state: 'state_123',
      },
    })).resolves.toMatchObject({
      intentId: 'connect_intent_checkout',
    });
  });

  it('gets intent status', async () => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);

      expect(request.method).toBe('GET');
      expect(request.url).toBe('https://rare-api.test/v1/connect/intents/connect_intent_123');

      return jsonResponse({
        data: {
          intentId: 'connect_intent_123',
          type: 'checkout',
          status: 'completed',
          returnPath: '/thanks',
          expiresAt: '2026-06-22T00:00:00.000Z',
          result: { transactionHash: '0xtransaction' },
        },
      });
    });

    await expect(getConnectIntent({
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
      intentId: 'connect_intent_123',
    })).resolves.toMatchObject({
      intentId: 'connect_intent_123',
      status: 'completed',
    });
  });

  it('preserves seller completion and payment fields in intent status', async () => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);

      expect(request.method).toBe('GET');
      expect(request.url).toBe('https://rare-api.test/v1/connect/intents/seller_listing_intent');

      return jsonResponse({
        data: {
          intentId: 'seller_listing_intent',
          type: 'seller-listing-manager',
          status: 'completed',
          returnPath: '/inventory',
          expiresAt: '2026-06-22T00:00:00.000Z',
          payment: {
            method: 'card',
            recipient: '0x0000000000000000000000000000000000000001',
            recipientBoundByCheckout: true,
          },
          result: {
            paymentId: 'coinflow_payment_123',
            sellerCompletion: {
              kind: 'listing-manager',
              productId: '123',
              chainId: 11155111,
              cartAddress: '0x0000000000000000000000000000000000000002',
              rootDigest: '0xroot',
              listingDigests: ['0xlisting'],
            },
          },
        },
      });
    });

    await expect(getConnectIntent({
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
      intentId: 'seller_listing_intent',
    })).resolves.toMatchObject({
      payment: {
        method: 'card',
        recipientBoundByCheckout: true,
      },
      result: {
        paymentId: 'coinflow_payment_123',
        sellerCompletion: {
          kind: 'listing-manager',
          productId: '123',
          chainId: 11155111,
          listingDigests: ['0xlisting'],
        },
      },
    });
  });

  it('parses intent status carrying an offer snapshot with buyer and expiry terms', async () => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);

      expect(request.method).toBe('GET');
      expect(request.url).toBe('https://rare-api.test/v1/connect/intents/connect_intent_offer');

      return jsonResponse({
        data: {
          intentId: 'connect_intent_offer',
          type: 'offer',
          status: 'completed',
          returnPath: '/offer/complete',
          expiresAt: '2026-06-22T00:00:00.000Z',
          resolvedActionSnapshot: {
            actionKey: 'offer_key',
            actionType: 'offer',
            resolvedAt: '2026-06-21T00:00:00.000Z',
            targetKind: 'erc721-offer',
            terms: {
              available: true,
              amount: '1.2',
              currency: 'ETH',
              buyer: '0x0000000000000000000000000000000000000001',
              expiry: '1750550400',
            },
          },
          result: { transactionHash: '0xtransaction' },
        },
      });
    });

    await expect(getConnectIntent({
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
      intentId: 'connect_intent_offer',
    })).resolves.toMatchObject({
      intentId: 'connect_intent_offer',
      type: 'offer',
      resolvedActionSnapshot: {
        targetKind: 'erc721-offer',
        terms: {
          buyer: '0x0000000000000000000000000000000000000001',
          expiry: '1750550400',
        },
      },
    });
  });

  it('gets checkout status', async () => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);

      expect(request.method).toBe('GET');
      expect(request.url).toBe('https://rare-api.test/v1/connect/checkout/connect_checkout_session_123');

      return jsonResponse({
        data: {
          sessionId: 'connect_checkout_session_123',
          status: 'completed',
          intentId: 'connect_intent_checkout',
          transactionHash: '0xtransaction',
        },
      });
    });

    await expect(getConnectCheckoutStatus({
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
      sessionId: 'connect_checkout_session_123',
    })).resolves.toMatchObject({
      sessionId: 'connect_checkout_session_123',
      status: 'completed',
    });
  });

  it('parses checkout status carrying a batch-offer snapshot with buyer and expiry terms', async () => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);

      expect(request.method).toBe('GET');
      expect(request.url).toBe('https://rare-api.test/v1/connect/checkout/connect_checkout_session_offer');

      return jsonResponse({
        data: {
          sessionId: 'connect_checkout_session_offer',
          status: 'completed',
          intentId: 'connect_intent_offer_accept',
          transactionHash: '0xtransaction',
          resolvedActionSnapshot: {
            actionKey: 'offer_accept_key',
            actionType: 'offer-accept',
            resolvedAt: '2026-06-21T00:00:00.000Z',
            targetKind: 'erc721-batch-offer',
            terms: {
              available: true,
              amount: '1.2',
              currency: 'ETH',
              buyer: '0x0000000000000000000000000000000000000001',
              expiry: '1750550400',
              merkleRoot: '0xroot',
            },
          },
        },
      });
    });

    await expect(getConnectCheckoutStatus({
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
      sessionId: 'connect_checkout_session_offer',
    })).resolves.toMatchObject({
      sessionId: 'connect_checkout_session_offer',
      status: 'completed',
      resolvedActionSnapshot: {
        targetKind: 'erc721-batch-offer',
        terms: {
          buyer: '0x0000000000000000000000000000000000000001',
          expiry: '1750550400',
        },
      },
    });
  });

  it('gets API-backed session state with bearer auth', async () => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);

      expect(request.method).toBe('GET');
      expect(request.url).toBe('https://rare-api.test/v1/connect/session');
      expect(request.headers.get('authorization')).toBe('Bearer connect_session_123');

      return jsonResponse({
        data: {
          authenticated: true,
          session: {
            sessionId: 'connect_session_123',
            userId: 'user_123',
            address: '0x0000000000000000000000000000000000000001',
            expiresAt: '2026-06-22T00:00:00.000Z',
          },
        },
      });
    });

    await expect(getConnectSession({
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
      sessionId: 'connect_session_123',
    })).resolves.toEqual({
      authenticated: true,
      session: {
        sessionId: 'connect_session_123',
        userId: 'user_123',
        address: '0x0000000000000000000000000000000000000001',
        expiresAt: '2026-06-22T00:00:00.000Z',
      },
    });
  });

  it('gets current user with bearer auth', async () => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);

      expect(request.method).toBe('GET');
      expect(request.url).toBe('https://rare-api.test/v1/connect/users/me');
      expect(request.headers.get('authorization')).toBe('Bearer connect_session_123');

      return jsonResponse({
        data: {
          address: '0x0000000000000000000000000000000000000001',
          username: 'artist',
          fullName: 'Artist Name',
          avatarUri: null,
        },
      });
    });

    await expect(getConnectCurrentUser({
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
      sessionId: 'connect_session_123',
    })).resolves.toEqual({
      address: '0x0000000000000000000000000000000000000001',
      username: 'artist',
      fullName: 'Artist Name',
      avatarUri: null,
    });
  });

  it('lists account-owned Products with the Connect session', async () => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);

      expect(request.method).toBe('GET');
      expect(request.url).toBe('https://rare-api.test/v1/cart/products/mine?page=2&perPage=10');
      expect(request.headers.get('authorization')).toBe('Bearer connect_session_123');

      return jsonResponse({
        data: [productFixture],
        hasNextPage: false,
      });
    });

    await expect(listConnectProductsMine({
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
      page: 2,
      perPage: 10,
      sessionId: 'connect_session_123',
    })).resolves.toEqual({ data: [productFixture], hasNextPage: false });
  });

  it('creates and publishes Products through account-scoped endpoints', async () => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);
      expect(request.headers.get('authorization')).toBe('Bearer connect_session_123');

      if (request.url === 'https://rare-api.test/v1/cart/products') {
        expect(request.url).toBe('https://rare-api.test/v1/cart/products');
        expect(await request.json()).toEqual({
          slug: 'artist-work',
          metadata: { title: 'Artist Work' },
        });
      } else {
        expect(request.method).toBe('POST');
        expect(request.url).toBe('https://rare-api.test/v1/cart/products/123/publish');
      }

      return jsonResponse({ data: productFixture });
    });

    await expect(createConnectProduct({
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
      product: { slug: 'artist-work', metadata: { title: 'Artist Work' } },
      sessionId: 'connect_session_123',
    })).resolves.toEqual(productFixture);
    await expect(publishConnectProduct({
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
      productId: '123',
      sessionId: 'connect_session_123',
    })).resolves.toEqual(productFixture);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it('uses the Rare API candidate path and persistence-page variant response', async () => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);
      expect(request.headers.get('authorization')).toBe('Bearer connect_session_123');
      if (request.method === 'GET') {
        expect(request.url).toBe('https://rare-api.test/v1/cart/products/variant-candidates?page=1&perPage=20&productId=123');
      } else {
        expect(request.url).toBe('https://rare-api.test/v1/cart/products/123/variants');
        expect(await request.json()).toEqual({ universalTokenIds: ['11155111-0xcontract-42'] });
      }

      return request.method === 'GET'
        ? jsonResponse({
          records: [{
            resourceType: 'cart_nft_candidate',
            id: '1',
            record: { universal_token_id: '11155111-0xcontract-42', sku: null, is_attached: false },
          }],
          hasNextPage: false,
        })
        : jsonResponse({ data: productFixture });
    });

    await expect(listConnectProductCandidates({
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
      productId: '123',
      sessionId: 'connect_session_123',
    })).resolves.toMatchObject({ records: [{ resourceType: 'cart_nft_candidate' }] });
    await expect(addConnectProductVariants({
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
      product: { productId: '123', universalTokenIds: ['11155111-0xcontract-42'] },
      sessionId: 'connect_session_123',
    })).resolves.toEqual(productFixture);
  });

  it('uses the owner Product detail and restore routes', async () => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);
      expect(request.headers.get('authorization')).toBe('Bearer connect_session_123');
      expect(request.url).toMatch(/https:\/\/rare-api\.test\/v1\/cart\/products(?:\/mine\/123|\/123\/restore)$/);
      return jsonResponse({ data: productFixture });
    });

    await expect(getConnectProductMine({
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
      productId: '123',
      sessionId: 'connect_session_123',
    })).resolves.toEqual(productFixture);
    await expect(restoreConnectProductToDraft({
      apiUrl: 'https://rare-api.test',
      fetch: fetchImplementation,
      productId: '123',
      sessionId: 'connect_session_123',
    })).resolves.toEqual(productFixture);
  });
});

const productFixture = {
  id: '123',
  userId: '456',
  slug: 'artist-work',
  status: 'DRAFT' as const,
  metadata: { title: 'Artist Work', displayMode: 'gallery' },
  variants: [],
  createdAt: '2026-06-22T00:00:00.000Z',
  updatedAt: '2026-06-22T00:00:00.000Z',
};

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json' },
  });
}
