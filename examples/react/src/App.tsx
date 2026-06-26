import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { JSX } from 'react';
import { createRareClient, type Nft } from '@rareprotocol/rare-cli/client';
import {
  createSuperRareClient,
  resolveConnectIntentOutcome,
  type ConnectErc721DirectListingTarget,
  type ConnectExpectedPriceTerms,
  type ConnectIntent,
  type ConnectSession,
  type SuperRareConnectClient,
} from '@superrare/connect';
import { createPublicClient, formatUnits, http } from 'viem';
import { sepolia } from 'viem/chains';

const superrare = createSuperRareClient({
  apiUrl: import.meta.env.VITE_SUPERRARE_API_URL,
  connectUrl: import.meta.env.VITE_SUPERRARE_CONNECT_URL,
  fetch: fetchWithTimeout,
  navigation: false,
});

const rare = createRareClient({
  publicClient: createPublicClient({
    chain: sepolia,
    transport: http(readOptionalEnvironmentString(import.meta.env.VITE_SEPOLIA_RPC_URL)),
  }),
  apiBaseUrl: readOptionalEnvironmentString(import.meta.env.VITE_SUPERRARE_API_URL),
  apiFetch: fetchWithTimeout,
});

const requestTimeoutMilliseconds = 60_000;
const connectIntentPath = '/v1/connect/intents';
const connectDebugEnabled = import.meta.env.VITE_CONNECT_DEBUG === 'true';

type DebugEntry = {
  id: string;
  timestamp: string;
  label: string;
  data: unknown;
};

type DebugListener = (entry: DebugEntry) => void;

const debugListeners = new Set<DebugListener>();

type SaleableErc721Artwork = {
  universalTokenId: string;
  title: string;
  imageUri: string | null;
  displayPrice: string;
  seller: string;
  target: ConnectErc721DirectListingTarget;
  expected: ConnectExpectedPriceTerms;
};

type ArtworkLoadState =
  | { status: 'loading' }
  | { status: 'loaded'; artworks: SaleableErc721Artwork[] }
  | { status: 'failed'; message: string };

export function App(): JSX.Element {
  const client = useMemo(() => superrare, []);
  const session = useConnectSession(client);
  const [debugEntries, setDebugEntries] = useState<DebugEntry[]>([]);
  const [artworkLoadState, setArtworkLoadState] = useState<ArtworkLoadState>({ status: 'loading' });
  const [selectedArtworkId, setSelectedArtworkId] = useState('');
  const [intentId, setIntentId] = useState('');
  const [hostedUrl, setHostedUrl] = useState('');
  const [intent, setIntent] = useState<ConnectIntent | undefined>();
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!connectDebugEnabled) return;

    const listener: DebugListener = (entry) => {
      setDebugEntries((entries) => [entry, ...entries].slice(0, 20));
    };

    debugListeners.add(listener);
    return () => {
      debugListeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    rare.search.nfts({
      hasListing: true,
      listingType: 'SALE_PRICE',
      perPage: 12,
      sortBy: 'priceAsc',
    }).then((response) => {
      if (cancelled) return;

      const artworks = response.data.flatMap((nft) => {
        const artwork = toSaleableErc721Artwork(nft);
        return artwork === undefined ? [] : [artwork];
      });

      const firstArtwork = artworks[0];
      setArtworkLoadState({ status: 'loaded', artworks });
      setSelectedArtworkId((currentId) => (
        currentId.length > 0 ? currentId : firstArtwork?.universalTokenId ?? ''
      ));
    }).catch((error: unknown) => {
      if (cancelled) return;

      setArtworkLoadState({ status: 'failed', message: formatError(error) });
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (window.location.search.length === 0) return;

    client.auth.exchangeCallback(new URLSearchParams(window.location.search))
      .then((sessionResult) => {
        setMessage(`Signed in as ${sessionResult.address}`);
      })
      .catch((error: unknown) => {
        setMessage(formatError(error));
      });
  }, [client]);

  useEffect(() => {
    if (intentId.trim().length === 0) return;

    const intervalId = window.setInterval(() => {
      client.intents.get({ intentId })
        .then(setIntent)
        .catch((error: unknown) => {
          setMessage(formatError(error));
          window.clearInterval(intervalId);
        });
    }, 3000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [client, intentId]);

  const intentOutcome = intent === undefined ? undefined : resolveConnectIntentOutcome(intent);
  const saleableArtworks = artworkLoadState.status === 'loaded' ? artworkLoadState.artworks : [];
  const selectedArtwork = getSelectedArtwork(saleableArtworks, selectedArtworkId);

  return (
    <main>
      <h1>SuperRare Connect</h1>

      <section>
        <h2>For-sale Sepolia ERC-721s</h2>
        {renderArtworkSelector({
          artworkLoadState,
          selectedArtworkId,
          onSelectedArtworkIdChange: setSelectedArtworkId,
        })}
        <button
          type="button"
          disabled={selectedArtwork === undefined}
          onClick={() => {
            if (selectedArtwork === undefined) return;

            setMessage('Creating ERC-721 buy intent...');
            setHostedUrl('');
            emitDebugEntry(
              'Selected artwork for buy intent',
              {
                target: selectedArtwork.target,
                expected: selectedArtwork.expected,
                displayPrice: selectedArtwork.displayPrice,
              },
            );
            void client.actions.buy({
              target: selectedArtwork.target,
              expected: selectedArtwork.expected,
              returnPath: '/buy/complete',
            }).then((createdIntent) => {
              emitDebugEntry(
                'SDK returned Connect intent',
                {
                  intent: createdIntent,
                  url: describeConnectUrl(createdIntent.url),
                },
              );
              setIntentId(createdIntent.intentId);
              setHostedUrl(createdIntent.url);
              setMessage(`Created intent ${createdIntent.intentId}`);
            }).catch((error: unknown) => {
              emitDebugEntry(
                'Connect intent creation failed',
                {
                  error: formatError(error),
                },
              );
              setMessage(formatError(error));
            });
          }}
        >
          Buy selected artwork
        </button>
        {hostedUrl.length > 0 ? (
          <p>
            <a
              href={hostedUrl}
              onClick={() => {
                emitDebugEntry(
                  'Opening hosted Connect flow',
                  {
                    url: describeConnectUrl(hostedUrl),
                  },
                );
              }}
            >
              Open hosted Connect flow
            </a>
          </p>
        ) : null}
      </section>

      {connectDebugEnabled ? (
        <section>
          <h2>Debug</h2>
          <button type="button" onClick={() => setDebugEntries([])}>
            Clear debug log
          </button>
          <pre>{JSON.stringify(debugEntries, null, 2)}</pre>
        </section>
      ) : null}

      <section>
        <h2>Intent status</h2>
        <label>
          Intent ID
          <input
            value={intentId}
            onChange={(event) => setIntentId(event.currentTarget.value)}
            placeholder="connect_intent_123"
          />
        </label>
        <pre>{JSON.stringify({ intent, outcome: intentOutcome }, null, 2)}</pre>
      </section>

      <section>
        <h2>Optional session</h2>
        <pre>{formatSession(session)}</pre>
        <button type="button" onClick={() => void client.auth.login({ returnPath: '/account' })}>
          Log in with SuperRare
        </button>
        <button type="button" onClick={() => client.auth.logout()}>
          Log out
        </button>
      </section>

      <section>
        <h2>Messages</h2>
        <pre>{message}</pre>
      </section>
    </main>
  );
}

function renderArtworkSelector(input: {
  artworkLoadState: ArtworkLoadState;
  selectedArtworkId: string;
  onSelectedArtworkIdChange: (artworkId: string) => void;
}): JSX.Element {
  if (input.artworkLoadState.status === 'loading') {
    return <p>Loading artworks...</p>;
  }

  if (input.artworkLoadState.status === 'failed') {
    return <pre>{input.artworkLoadState.message}</pre>;
  }

  if (input.artworkLoadState.artworks.length === 0) {
    return <p>No saleable Sepolia ERC-721 artworks were returned.</p>;
  }

  return (
    <>
      <label>
        Artwork
        <select
          value={input.selectedArtworkId}
          onChange={(event) => input.onSelectedArtworkIdChange(event.currentTarget.value)}
        >
          {input.artworkLoadState.artworks.map((artwork) => (
            <option key={artwork.universalTokenId} value={artwork.universalTokenId}>
              {formatArtworkOptionLabel(artwork)}
            </option>
          ))}
        </select>
      </label>
      {renderArtworkPreview(getSelectedArtwork(input.artworkLoadState.artworks, input.selectedArtworkId))}
    </>
  );
}

function renderArtworkPreview(artwork: SaleableErc721Artwork | undefined): JSX.Element | null {
  if (artwork === undefined) return null;

  return (
    <article>
      {artwork.imageUri === null ? null : (
        <img src={artwork.imageUri} alt={artwork.title} width="240" />
      )}
      <h3>{artwork.title}</h3>
      <dl>
        <dt>Token</dt>
        <dd>{artwork.target.contract}:{artwork.target.tokenId}</dd>
        <dt>Price</dt>
        <dd>{artwork.displayPrice}</dd>
        <dt>Seller</dt>
        <dd>{artwork.seller}</dd>
      </dl>
    </article>
  );
}

function useConnectSession(client: SuperRareConnectClient): ConnectSession | undefined {
  return useSyncExternalStore(
    client.auth.onChange,
    client.auth.getSession,
    () => undefined,
  );
}

function formatSession(session: ConnectSession | undefined): string {
  return JSON.stringify(session ?? { authenticated: false }, null, 2);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected Connect error';
}

function toSaleableErc721Artwork(nft: Nft): SaleableErc721Artwork | undefined {
  if (nft.type !== 'ERC721') return undefined;

  const listing = nft.market.listings.find((marketListing) => marketListing.type === 'SALE_PRICE');
  if (listing === undefined) return undefined;

  const chainId = Number(nft.chainId);
  if (!Number.isSafeInteger(chainId)) return undefined;

  return {
    universalTokenId: nft.universalTokenId,
    title: nft.metadata.name ?? `${nft.contractAddress} #${nft.tokenId}`,
    imageUri: nft.metadata.imageUri,
    displayPrice: formatPrice({
      amount: listing.price.cryptoAmount,
      currency: listing.price.currency.symbol,
      decimals: listing.price.currency.decimals,
    }),
    seller: listing.seller,
    target: {
      kind: 'erc721-direct-listing',
      chainId,
      contract: nft.contractAddress,
      tokenId: nft.tokenId,
    },
    expected: {
      currency: listing.price.currency.symbol,
      price: listing.price.cryptoAmount,
    },
  };
}

function getSelectedArtwork(
  artworks: SaleableErc721Artwork[],
  selectedArtworkId: string,
): SaleableErc721Artwork | undefined {
  const selectedArtwork = artworks.find((artwork) => artwork.universalTokenId === selectedArtworkId);
  if (selectedArtwork !== undefined) return selectedArtwork;

  return artworks[0];
}

function formatArtworkOptionLabel(artwork: SaleableErc721Artwork): string {
  return `${artwork.title} - ${artwork.displayPrice}`;
}

function formatPrice(input: {
  amount: string;
  currency: string;
  decimals: number;
}): string {
  return `${formatUnits(BigInt(input.amount), input.decimals)} ${input.currency}`;
}

function readOptionalEnvironmentString(value: string | undefined): string | undefined {
  const trimmedValue = value?.trim();
  return trimmedValue === undefined || trimmedValue.length === 0 ? undefined : trimmedValue;
}

async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => {
    controller.abort();
  }, requestTimeoutMilliseconds);
  const request = new Request(input, {
    ...init,
    signal: controller.signal,
  });
  const shouldLogConnectIntent = isConnectIntentCreationRequest(request);

  try {
    if (shouldLogConnectIntent) {
      emitDebugEntry('Rare API Connect intent request', {
        method: request.method,
        url: request.url,
        body: await readRequestBody(request),
        configuredApiUrl: import.meta.env.VITE_SUPERRARE_API_URL,
        configuredConnectUrl: import.meta.env.VITE_SUPERRARE_CONNECT_URL,
      });
    }

    const response = await fetch(request);

    if (shouldLogConnectIntent) {
      const responseBody = await readResponseBody(response);
      emitDebugEntry('Rare API Connect intent response', {
        status: response.status,
        ok: response.ok,
        body: responseBody,
        rawUrl: getConnectIntentResponseUrl(responseBody),
        rawUrlDetails: describeConnectUrl(getConnectIntentResponseUrl(responseBody)),
      });
    }

    return response;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('Rare API request timed out after 60 seconds while creating the Connect intent.');
    }

    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function emitDebugEntry(label: string, data: unknown): void {
  if (!connectDebugEnabled) return;

  const entry = {
    id: globalThis.crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    label,
    data,
  };
  debugListeners.forEach((listener) => listener(entry));
}

function isConnectIntentCreationRequest(request: Request): boolean {
  const url = new URL(request.url);
  return request.method === 'POST' && url.pathname === connectIntentPath;
}

async function readRequestBody(request: Request): Promise<unknown> {
  const body = await request.clone().text();
  return parseJsonForDebug(body);
}

async function readResponseBody(response: Response): Promise<unknown> {
  const body = await response.clone().text();
  return parseJsonForDebug(body);
}

function parseJsonForDebug(value: string): unknown {
  if (value.trim().length === 0) return null;

  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    return value;
  }
}

function getConnectIntentResponseUrl(value: unknown): string | undefined {
  if (
    typeof value === 'object' &&
    value !== null &&
    'data' in value &&
    typeof value.data === 'object' &&
    value.data !== null &&
    'url' in value.data &&
    typeof value.data.url === 'string'
  ) {
    return value.data.url;
  }

  return undefined;
}

function describeConnectUrl(value: string | undefined): unknown {
  if (value === undefined) return undefined;

  try {
    const url = new URL(value);
    const executionSessionId = url.searchParams.get('executionSessionId');
    return {
      href: url.href,
      origin: url.origin,
      pathname: url.pathname,
      search: url.search,
      hasStartPath: url.pathname.endsWith('/start'),
      executionSessionId,
      hasExecutionSessionId: executionSessionId !== null && executionSessionId.length > 0,
    };
  } catch {
    return {
      href: value,
      parseError: 'invalid_url',
    };
  }
}
