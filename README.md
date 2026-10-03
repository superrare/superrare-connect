# @rareprotocol/connect

Public browser SDK for starting SuperRare-hosted Connect flows from external websites.

SuperRare Connect handles wallet connection, checkout, buys, bids, mints, auction settlement, wallet-to-wallet transfers, payment, and transaction execution on SuperRare-controlled origins. Integrator sites use this SDK to create hosted intents, open them in their own window, and read intent status. Auth helpers are available, but checkout, buy, bid, mint, settle, transfer, and status flows do not require an authenticated Connect session.

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
  // Bid amounts are the currency's raw base units (wei for ETH), like offer
  // amounts: '1200000000000000000' is 1.2 ETH. Rare API rejects decimals.
  bid: { currency: 'ETH', amount: '1200000000000000000' },
  returnPath: '/bid/complete',
});

// Scheduled (no-reserve) auctions take the same target shape. Rare API reads
// the auction on-chain and refuses the intent before the auction starts
// (`AUCTION_NOT_STARTED`) or after it ends (`AUCTION_ENDED`). Only the first
// bid is checked against the auction's minimum; the increment over an
// existing bid is enforced by the auction contract, so compute the next valid
// bid with `@rareprotocol/rare-sdk` `auction.status()` before starting one.
await superrare.actions.bid({
  target: {
    kind: 'erc721-scheduled-auction',
    chainId: 11155111,
    contract: '0x345ea85bc5391a55a46c9508727b37da2227b41e',
    tokenId: '4',
  },
  bid: { currency: 'ETH', amount: '1200000000000000000' },
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

Every action except `transfer` accepts an optional `payment` hint (transfers are wallet-only; see [Transfers](#transfers)). Set `payment: { method: 'wallet' }` to keep the hosted checkout wallet-only: the hosted page never offers card payment, and Rare API refuses card preparation for the intent.

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

## Transfers

`actions.transfer` asks the user to send an exact amount of ETH or USDC from their wallet to a wallet you name, for example to pay for off-chain goods such as game credits. The user signs in and confirms in the hosted window, which shows the amount, the network, and the full destination address before anything is sent.

```ts
const intent = await superrare.actions.transfer({
  chainId: 1,
  to: '0x52908400098527886E0F7030069857D2E4169EE7',
  currency: 'USDC',
  amount: '25000000', // 25 USDC
  returnPath: '/credits/complete',
});

// Tie the intent to the order before the user can finish paying.
await fetch('/api/orders/order_123/transfer-intent', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ intentId: intent.intentId }),
});
```

- Chains: Ethereum mainnet (`chainId: 1`) and Sepolia (`11155111`). Production accepts mainnet only; for Sepolia use the dev `apiUrl`/`connectUrl` pair in [Testing on Sepolia](#testing-on-sepolia), which accepts both.
- Currencies: `ETH` and `USDC`.
- `amount` is a raw base-unit string, like bid and offer amounts: wei for ETH (`'50000000000000000'` is 0.05 ETH) and 6 decimals for USDC (`'25000000'` is 25 USDC). The SDK rejects decimals, zero, and leading zeros with `ConnectActionValidationError` (`code: 'invalid_amount'`) before any window opens.
- Wallet-only: there is no `payment` option and the hosted window never offers card. The user pays from the wallet they sign in with, and the hosted window keeps the confirm button disabled while that wallet cannot cover the amount.
- Rare API rejects the call with `SuperRareConnectApiError` (`status` 400) for a chain its deployment does not accept (any chain but mainnet in production), an invalid or zero address as `to`, an unknown currency, or a card payment or `payment.recipient` sent to the API directly.

### Verifying a transfer before crediting

The user controls the page, so nothing it reports proves a payment: not the `actions.transfer` result, not `onIntentSettled`, and never an amount or chain sent from the page. Grant goods only from your backend, based on the intent it reads itself:

1. The page calls `actions.transfer` and sends the returned `intentId` to your backend, as in the example above. The backend records it against the pending order: player, product, and the expected `recipient`, `amount`, `currency`, and `chainId`. Always create the intent from the page: SDK actions need a page, and the SDK cannot open an intent it did not create.
2. Treat `onIntentSettled` only as a hint to check. The backend reads the intent itself with `GET /v1/connect/intents/:intentId`, or with `intents.get` server-side.
3. Credit only when all of these hold:
   - `status === 'completed'`. A `processing` intent can already carry an unverified `result.transactionHash`; never credit it.
   - `resolvedActionSnapshot.actionType === 'transfer'`.
   - The terms `chainId`, `recipient`, `amount`, and `currency` equal the order's. `recipient` comes back checksummed, so compare addresses case-insensitively. A Sepolia transfer must never credit a mainnet order.
   - The `intentId` was not credited before, for example with a unique constraint on the column that stores credited intent ids. `isTransferPaid` below checks everything else.

```ts
import { createSuperRareClient } from '@rareprotocol/connect';

const superrare = createSuperRareClient({ sessionStorage: false });

type TransferOrder = {
  intentId: string;
  chainId: 1 | 11155111;
  recipient: string;
  currency: 'ETH' | 'USDC';
  amount: string;
};

async function isTransferPaid(order: TransferOrder): Promise<boolean> {
  const intent = await superrare.intents.get({ intentId: order.intentId });
  const snapshot = intent.resolvedActionSnapshot;

  return (
    intent.status === 'completed' &&
    snapshot?.actionType === 'transfer' &&
    snapshot.terms.chainId === order.chainId &&
    snapshot.terms.recipient?.toLowerCase() === order.recipient.toLowerCase() &&
    snapshot.terms.amount === order.amount &&
    snapshot.terms.currency === order.currency
  );
}
```

A `completed` transfer means SuperRare verified on-chain that the wallet signed in to the hosted window at confirmation paid exactly `amount` of `currency` to `recipient` on `chainId`, in a transaction mined after the intent was created. One transaction completes at most one transfer per paying wallet; a smart-account bundle that carries several payers' transfers completes one intent for each.

If the intent is still `processing` when your backend reads it and it already carries `result.transactionHash` (the player closed the window, or confirmation took longer than usual), keep reading it: each read lets SuperRare re-verify the payment on-chain and complete the intent. Such a transfer stays readable for 24 hours after the intent's `expiresAt`, and a `completed` transfer is kept for the same 24 hours, so read and record it within that window. A transfer whose hash was not recorded before the intent expired is not completed automatically: the wallet approved it after the intent expired, the player closed the window before approving, or the player sped it up in their wallet after the window stopped watching.

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

Auth is available for integrations that need a Connect session or `user.me()`. It is not required for checkout, buy, bid, mint, transfer, or intent status.

`auth.login()` runs the login in a small centered window: the user authenticates on SuperRare Connect, the window closes itself, and the promise resolves with the session — including the authenticated wallet address — plus the signed-in user's profile. Your page never navigates away.

```ts
const result = await superrare.auth.login();

if (result.status === 'authenticated') {
  result.session.address; // the authenticated wallet
  result.user?.username;  // profile info; undefined if the lookup failed
}
```

Call it directly from a click handler so the browser allows the window. Possible results:

- `authenticated` — the session is stored and `auth.onChange` listeners fired; `user` carries `address`, `username`, `fullName`, and `avatarUri` when the profile lookup succeeds.
- `cancelled` — the user closed the window before signing in, or a logout/newer login on this client landed before the session was committed. (A logout *after* the session was committed — e.g. during the profile lookup — resolves `authenticated`; the login succeeded and the later logout clears the session.)
- `expired` — the login intent expired while the window was open.

When the window cannot be opened at all (a popup blocker, or a call outside a user gesture), `auth.login()` rejects with `ConnectPopupBlockedError` before any intent is created — there is no same-page fallback.

Only one login runs at a time per client: the SDK holds a single session, so calling `login()` again while one is in flight joins the running login instead of opening a second window. If the backend stops responding after the callback arrives, the call rejects rather than hanging. `auth.loginWithPopup()` remains as a deprecated alias of `auth.login()`.

On iOS Safari the page is suspended the moment the hosted window takes focus, which has two consequences the SDK covers for you. First, the callback the hosted page posts when the login completes never arrives: the login therefore also claims its result from Rare API whenever the page becomes visible again or the hosted window is found closed, and a closed window is reported as `cancelled` only once Rare API confirms nothing completed. Second, `auth.login()` opens the window first and navigates it once the intent exists; if the page is suspended before that round trip finishes, the window stays blank. To rule that out, create the intent ahead of the tap with `auth.prepareLogin()` (on page load, or when the person is about to tap): the next `auth.login()` with the same params then opens the window already pointed at the hosted page, inside the gesture, with no round trip in between. A prepared login lasts as long as its intent (about fifteen minutes) and is dropped after a logout; `login` creates a fresh intent when none is usable.

```ts
await superrare.auth.prepareLogin();

button.addEventListener('click', () => {
  void superrare.auth.login();
});
```

For controlled environments (tests, non-browser hosts), `popup.open`, `popup.messageEvents` and `popup.visibilityEvents` let you supply the window opener, the `message`-event source the login listens on, and the page-visibility source it claims on:

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

Both default to the browser's own `window.open` and `window.addEventListener('message', ...)`.

Under the hood the hosted page reports the auth callback to the opener with a `postMessage`; the SDK only accepts messages from the Connect origin, verifies `state` and `intentId` against the login it started (so it works with `sessionStorage: false` too), and then exchanges the one-time code server-side — the wallet address comes from the exchanged session, never from the message. A login that completes after `auth.logout()` ran on the same client resolves `cancelled` instead of resurrecting the session.

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

Use `connectUrl` to force hosted intent URLs to a matching Connect deployment in staging or local environments. It must be `https:`, or `http:` only for a loopback host (`localhost`, `127.0.0.1`, `[::1]`) — a plaintext hosted page on any other host is rejected, since its origin would become the one the SDK trusts for the auth callback. Use `sessionStorage: false` for tests or controlled apps that do not want SDK-managed browser storage. Custom `popup`, `sessionStorage`, `fetch`, and `createState` implementations are supported for tests and custom integrations.

## Testing on Sepolia

Production (`connect.superrare.com`) is Ethereum mainnet only. To test an integration on the **Sepolia** testnet, point the client at the shared dev environment and pass the Sepolia chain id (`11155111`) on the action target:

```ts
const superrare = createSuperRareClient({
  apiUrl: 'https://rare-api-dev-mainnet.superrare.co',
  connectUrl: 'https://connect-dev-mainnet.superrare.co',
});

await superrare.actions.buy({
  target: {
    kind: 'erc721-direct-listing',
    chainId: 11155111, // Sepolia — the hosted window is pinned to this chain
    contract: '0x…',
    tokenId: '…',
  },
  expected: { currency: 'ETH', price: '…' }, // raw base units (wei)
});
```

The dev environment resolves and executes both mainnet (`1`) and Sepolia (`11155111`) listings; the hosted window runs on whichever chain the action names, with no in-window network switch. You need a testnet asset the buyer can actually purchase (a live Sepolia listing whose seller still owns the token) and a buyer wallet funded with Sepolia ETH. Switch back to the production `apiUrl`/`connectUrl` for mainnet.

## Hosted Windows

Every hosted flow — checkout, buy, bid, mint, settle, transfer, offers, and login — opens in a small centered window, the way wallet and social sign-in flows behave, so your page keeps its state while the buyer pays. `popup` shapes that window and `onIntentSettled` reports how the flow ended:

```ts
const superrare = createSuperRareClient({
  popup: { width: 480, height: 720 },
  onIntentSettled: (intent) => {
    // Fires with the terminal status when the flow finishes (the SDK closes
    // the window), with `status: 'expired'` when the server reports the
    // intent expired (the window is left open), or with the latest known
    // state if the buyer closes the window early or the fallback deadline
    // lapses — those two can be non-terminal, so check `intent.status`.
    refreshArtwork(intent);
  },
});
```

Call `actions.buy()` (or any other action) directly from the click handler: the window opens synchronously inside the user gesture, so browsers allow it. When the window cannot be opened, the call rejects with `ConnectPopupBlockedError` before any intent is created — there is no same-page fallback.

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
- `ConnectActionValidationError` for action parameters the SDK rejects before creating an intent, with `code` `invalid_amount` (a transfer amount that is not a positive base-unit integer).
- `ConnectPopupBlockedError` when the hosted window could not be opened (popup blocked, or the call ran outside a user gesture).
- `ConnectAuthPendingError` when the login callback's `intentId` or `state` does not match the login that was started.
- `ConnectSessionRequiredError` when a local session is required but missing.
- `SuperRareConnectApiError` for Rare API non-2xx responses, with `status` and `path`.

## Examples

- `examples/vanilla` shows direct browser usage.
- `examples/react` shows a React bundler app with login, session display, logout, Sepolia for-sale artwork discovery through `@rareprotocol/rare-cli`, buy intent creation, and intent polling.

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
