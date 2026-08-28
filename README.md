# @rareprotocol/connect

Public browser SDK for starting SuperRare-hosted Connect flows from external websites.

SuperRare Connect handles wallet connection, checkout, buys, bids, mints, auction settlement, payment, and transaction execution on SuperRare-controlled origins. Integrator sites use this SDK to create hosted intents, redirect users, and read intent status. Auth helpers are available, but checkout, buy, bid, mint, settle, and status flows do not require an authenticated Connect session.

## Install

```sh
pnpm add @rareprotocol/connect
```

```ts
import { createSuperRareClient } from '@rareprotocol/connect';

const superrare = createSuperRareClient();
```

For staging or local testing, pass the Rare API URL explicitly:

```ts
const superrare = createSuperRareClient({
  apiUrl: 'https://rare-api-bc4d-784573620320.us-east1.run.app',
  connectUrl: 'https://connect-com-bc4d-784573620320.us-east1.run.app',
});
```

## Browser Embed

```html
<script src="https://cdn.example.com/superrare-connect.global.js"></script>
<script>
  const superrare = SuperRareConnect.createSuperRareClient();

  document.querySelector('#buy').addEventListener('click', function () {
    superrare.actions.buy({
      target: {
        kind: 'erc721-direct-listing',
        chainId: 11155111,
        contract: '0x252f829f6ea6623c883d6f433dc6999b94817419',
        tokenId: '1'
      },
      expected: { currency: 'ETH', price: '1000000000000' },
      returnPath: '/buy/complete',
    });
  });
</script>
```

The global bundle exposes:

```ts
SuperRareConnect.createSuperRareClient
SuperRareConnect.normalizeReturnPath
SuperRareConnect.resolveConnectIntentOutcome
```

ESM CDN-style usage:

```html
<script type="module">
  import { createSuperRareClient } from 'https://cdn.example.com/@rareprotocol/connect/index.js';

  const superrare = createSuperRareClient();
</script>
```

## Anonymous ERC-721 Buy

Use the Rare Protocol SDK to fetch saleable Sepolia artworks, then pass the selected listing into SuperRare Connect:

```ts
import { createRareClient } from '@rareprotocol/rare-cli/client';
import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';

const rare = createRareClient({
  publicClient: createPublicClient({
    chain: sepolia,
    transport: http(),
  }),
});

const artworks = await rare.search.nfts({
  hasListing: true,
  listingType: 'SALE_PRICE',
  perPage: 12,
  sortBy: 'priceAsc',
});

const artwork = artworks.data.find((nft) => nft.type === 'ERC721');
if (artwork === undefined) throw new Error('No saleable Sepolia ERC-721 artwork found.');

const listing = artwork.market.listings.find((marketListing) => marketListing.type === 'SALE_PRICE');
if (listing === undefined) throw new Error('Selected artwork is not currently listed.');

const intent = await superrare.actions.buy({
  target: {
    kind: 'erc721-direct-listing',
    chainId: Number(artwork.chainId),
    contract: artwork.contractAddress,
    tokenId: artwork.tokenId,
  },
  expected: {
    currency: listing.price.currency.symbol,
    price: listing.price.cryptoAmount,
  },
  returnPath: '/buy/complete',
});
```

No login or Connect session is required. The hosted SuperRare flow handles wallet, payment, and transaction execution.

## ERC-1155 Checkout

`checkout.start` follows the Rare API `erc1155-checkout` target contract. Use `actions.buy` for ERC-721 direct or batch listing purchases.

```ts
const intent = await superrare.checkout.start({
  target: {
    kind: 'erc1155-checkout',
    chainId: 11155111,
    items: [
      {
        kind: 'listing',
        contract: '0x1234567890123456789012345678901234567890',
        seller: '0x2222222222222222222222222222222222222222',
        tokenId: '123',
        quantity: '1',
        expected: { currency: 'ETH', unitPrice: '1.2' },
      },
    ],
  },
  returnPath: '/thanks',
});

const checkout = await superrare.checkout.getStatus({
  sessionId: 'connect_checkout_session_123',
});
```

## Anonymous ERC-721 Bid And Mint

```ts
await superrare.actions.bid({
  target: {
    kind: 'erc721-reserve-auction',
    chainId: 11155111,
    contract: '0x345ea85bc5391a55a46c9508727b37da2227b41e',
    tokenId: '4',
  },
  bid: { currency: 'ETH', amount: '1.2' },
  returnPath: '/bid/complete',
});

await superrare.actions.mint({
  target: {
    kind: 'erc721-release',
    chainId: 11155111,
    contract: '0xb15272403dfd1e5efbe6f2dec12516d7947e2a1e',
  },
  purchase: { quantity: '1', currency: 'ETH', unitPrice: '1.2' },
  returnPath: '/mint/complete',
});
```

The SDK never accepts arbitrary calldata, contract instructions, private keys, API secrets, or wallet-provider objects from integrators.

## Payment Methods

Every action accepts an optional `payment` hint. Set `payment: { method: 'wallet' }` to keep the hosted checkout wallet-only: the hosted page never offers card payment, and Rare API refuses card preparation for the intent.

**Wallet-only is required when the sale settles on a custom contract whose mint or transfer logic depends on the receiving wallet** — for example a mint that binds a pre-registered artwork to the collector's address. Card settlement executes through a SuperRare buy-proxy that receives the asset itself and re-transfers it to the buyer, so the on-chain receiver is the proxy, not the buyer; such sales revert only after the card was charged. If your contract keys anything on the `mintTo` / transfer receiver, always create its intents wallet-only:

```ts
await superrare.actions.mint({
  target: {
    kind: 'erc721-release',
    chainId: 11155111,
    contract: '0xb15272403dfd1e5efbe6f2dec12516d7947e2a1e',
  },
  purchase: { quantity: '1', currency: 'ETH', unitPrice: '0.042' },
  payment: { method: 'wallet' },
  returnPath: '/mint/complete',
});
```

Omit `payment` to let the hosted checkout offer every method the listing supports.

## Anonymous Auction Settlement

Settling an ended reserve auction is permissionless: anyone can trigger it, and the outcome (winning bidder, amount, transfer) is already fixed on-chain, so no expected terms are supplied. Rare API resolves the ended auction across both auction houses and pins the settlement details into the hosted intent; the hosted page submits the `settleAuction` transaction from the connected wallet.

```ts
await superrare.actions.settle({
  target: {
    kind: 'erc721-reserve-auction',
    chainId: 11155111,
    contract: '0x345ea85bc5391a55a46c9508727b37da2227b41e',
    tokenId: '4',
  },
  returnPath: '/settle/complete',
});
```

Intent creation fails when the auction has not ended, has no winning bid, or was already settled.

## Intent Status

```ts
import { resolveConnectIntentOutcome } from '@rareprotocol/connect';

const intent = await superrare.intents.get({
  intentId: 'connect_intent_123',
});

const outcome = resolveConnectIntentOutcome(intent);
```

`outcome.kind` is `pending`, `completed`, or `failed`.

## Optional Auth Flow

Auth is available for integrations that need a Connect session or `user.me()`. It is not required for checkout, buy, bid, mint, or intent status.

```ts
await superrare.auth.login({
  returnPath: '/account',
});
```

Callback page:

```ts
try {
  const session = await superrare.auth.exchangeCallback(
    new URLSearchParams(window.location.search),
  );
} catch (error) {
  // `ConnectSessionSupersededError` — a logout or newer login on this client
  // landed while the exchange was in flight; the session was not stored.
  // Other errors: invalid/expired callback (see Errors below).
}
```

Flow sequence:

1. Site calls `auth.login({ returnPath })`.
2. SDK creates a login intent through Rare API.
3. SDK stores pending auth state in browser storage.
4. Browser redirects to SuperRare Connect.
5. SuperRare Connect redirects back to the integrator `returnPath` with `intentId`, `state`, and `code`.
6. Integrator calls `auth.exchangeCallback(new URLSearchParams(window.location.search))`.
7. SDK validates pending `state` and `intentId`, exchanges the code for a Connect session, stores the session, and notifies listeners. If a logout or a newer login on this client lands while the exchange is in flight, `exchangeCallback` throws `ConnectSessionSupersededError` and stores nothing, rather than returning a session that was superseded.

## Popup Login

`auth.loginWithPopup()` runs the same login in a small centered window instead of navigating away: the user authenticates on SuperRare Connect, the popup closes itself, and the promise resolves with the session — including the authenticated wallet address — plus the signed-in user's profile.

```ts
const result = await superrare.auth.loginWithPopup();

if (result.status === 'authenticated') {
  result.session.address; // the authenticated wallet
  result.user?.username;  // profile info; undefined if the lookup failed
}
```

Call it directly from a click handler so the browser does not block the popup. Possible results:

- `authenticated` — the session is stored and `auth.onChange` listeners fired; `user` carries `address`, `username`, `fullName`, and `avatarUri` when the profile lookup succeeds.
- `cancelled` — the user closed the popup before signing in, or a logout/newer login on this client landed before the session was committed. (A logout *after* the session was committed — e.g. during the profile lookup — resolves `authenticated`; the login succeeded and the later logout clears the session.)
- `expired` — the login intent expired while the popup was open.
- `redirected` — the popup was blocked, so the SDK fell back to the redirect login; the callback lands on `returnPath` as in the flow above.

Only one login runs at a time per client: the SDK holds a single session, so calling `loginWithPopup()` again while one is in flight joins the running login instead of opening a second window. If the backend stops responding after the callback arrives, the call rejects rather than hanging.

For controlled environments (tests, non-browser hosts), `popup.open` and `popup.messageEvents` let you supply the window opener and the `message`-event source the popup login listens on:

```ts
createSuperRareClient({
  popup: {
    open: (url, target, features) => window.open(url, target, features),
    messageEvents: {
      // Deliver every `message` event as { origin, data }; return the
      // unsubscribe function.
      subscribe: (listener) => {
        const handler = (event: MessageEvent) => {
          listener({ origin: event.origin, data: event.data });
        };
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
      },
    },
  },
});
```

Both default to the browser's own `window.open` and `window.addEventListener('message', ...)`. When the popup cannot be opened, the SDK falls back to the redirect login — that fallback needs session storage, so `loginWithPopup` throws instead of redirecting when storage is disabled and no popup is available.

Under the hood the hosted page reports the auth callback to the opener with a `postMessage`; the SDK only accepts messages from the Connect origin, verifies `state` and `intentId` against the login it started (so it works with `sessionStorage: false` too), and then exchanges the one-time code server-side — the wallet address comes from the exchanged session, never from the message. A popup login that completes after `auth.logout()` ran on the same client resolves `cancelled` instead of resurrecting the session; the redirect `exchangeCallback` throws `ConnectSessionSupersededError` in the same situation, so a superseded exchange is never mistaken for a live session.

## Session And User

```ts
const session = superrare.auth.getSession();
const remoteSession = await superrare.auth.getRemoteSession();
const user = await superrare.user.me();

const unsubscribe = superrare.auth.onChange((nextSession) => {
  // Update app state.
});

superrare.auth.logout();
unsubscribe();
```

`user.me()` requires a stored Connect session and throws `ConnectSessionRequiredError` when no local session exists.

## Options

```ts
const superrare = createSuperRareClient({
  apiUrl: 'https://api.superrare.com',
  connectUrl: 'https://connect.superrare.com',
  navigation: false,
  sessionStorage: false,
});
```

Use `connectUrl` to force hosted intent URLs to a matching Connect deployment in staging or local environments. It must be `https:`, or `http:` only for a loopback host (`localhost`, `127.0.0.1`, `[::1]`) — a plaintext hosted page on any other host is rejected, since its origin would become the one the SDK trusts for the auth callback. Use `navigation: false` to create hosted intents without assigning `window.location`. Use `sessionStorage: false` for tests or controlled apps that do not want SDK-managed browser storage. Custom `navigation`, `sessionStorage`, `fetch`, and `createState` implementations are supported for tests and custom integrations.

## Popup Checkout

By default a hosted action navigates the current page. Set `display: 'popup'` to open the hosted flow in a small centered window instead — the way wallet and social sign-in flows behave — so your page keeps its state while the buyer pays.

```ts
const superrare = createSuperRareClient({
  display: 'popup',
  popup: { width: 480, height: 720 },
  onIntentSettled: (intent) => {
    // Fires with the terminal status when the flow finishes (the SDK closes
    // the window), with `status: 'expired'` when the server reports the
    // intent expired (the window is left open), or with the latest known
    // state if the buyer closes the popup early or the fallback deadline
    // lapses — those two can be non-terminal, so check `intent.status`.
    refreshArtwork(intent);
  },
});
```

Call `actions.buy()` (or any other action) directly from the click handler: the popup opens synchronously inside the user gesture, so browsers do not block it. When a popup cannot be opened the SDK falls back to the redirect flow. `auth.login()` always redirects because the auth callback must return to your page; use `auth.loginWithPopup()` for the popup counterpart.

## Return Path Safety

Public flow parameters use `returnPath`, not `returnUrl`.

Valid values are same-origin relative paths:

```ts
returnPath: '/thanks'
returnPath: '/checkout/complete?listing=123'
```

Rejected values include absolute URLs, protocol-relative URLs, backslashes, encoded slash or backslash bypasses, control characters, empty strings, and paths without a leading slash.

```ts
import { normalizeReturnPath } from '@rareprotocol/connect';

const result = normalizeReturnPath('/account');
```

## Errors

The SDK throws typed errors for branchable public failures:

- `ConnectReturnPathError` for invalid `returnPath`.
- `ConnectAuthCallbackError` for missing, duplicate, or malformed callback parameters.
- `ConnectAuthPendingError` when callback `intentId` or `state` does not match pending auth.
- `ConnectSessionRequiredError` when a local session is required but missing.
- `SuperRareConnectApiError` for Rare API non-2xx responses, with `status` and `path`.

## Examples

- `examples/vanilla` shows direct browser usage.
- `examples/react` shows a React bundler app with login, callback exchange, session display, logout, Sepolia for-sale artwork discovery through `@rareprotocol/rare-cli`, buy intent creation, and intent polling.

## Development

```sh
pnpm install
pnpm test
pnpm build
```

Package outputs:

- `dist/index.js` for ESM bundlers.
- `dist/index.cjs` for CommonJS consumers.
- `dist/superrare-connect.global.js` for direct browser script usage.
- `dist/index.d.ts` for TypeScript declarations.
