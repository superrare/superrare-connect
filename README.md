# @rareprotocol/connect

Public browser SDK for starting SuperRare-hosted Connect flows from external websites.

SuperRare Connect handles wallet connection, checkout, buys, bids, mints, auction settlement, Liquid Edition trades, wallet-to-wallet transfers, payment, and transaction execution on SuperRare-controlled origins. Integrator sites use this SDK to create hosted intents, open them in their own window, and read intent status. Auth helpers are available, but checkout, buy, bid, mint, settle, transfer, and status flows do not require an authenticated Connect session.

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

## Studio Games, Credits, And Leaderboards (Beta)

**Beta access:** This feature is not generally released. Use is limited to integrations with a beta API key. Contact SuperRare for beta access before using this SDK surface.

Games use an explicit Studio origin; `studioUrl` is not the Rare/Connect API URL. A free game does not need a credit group:

```ts
const superrare = createSuperRareClient({
  studioUrl: 'https://studio.example',
});
const game = superrare.games.forGame({ appId: 'your-studio-product-uuid' });
const freeStartKey = crypto.randomUUID();
const started = await game.start({ clientBuildId: 'web-2026-10-06', idempotencyKey: freeStartKey });
```
Pass the same `idempotencyKey` when retrying an unresolved free start.

For a Studio-configured credit-gated game, include its group. Connect the game once from an explicit click with `game.connect()`: it opens only Studio's `/connect/games/authorize` surface and reuses a valid scoped authorization on later calls. Studio handles Connect login and an explicit **Connect game** action. Connecting does not reserve or spend credits, request consent, or start a play.

Your game—not the SDK—owns the one-play confirmation UI. Fetch authoritative terms with `getTerms()`, display the title and credit cost, and offer a separate **Play — spend N credits** action. Only that confirmation action may call `requestConsent`. There is no SDK confirmation popup per play:

```ts
const paidGame = superrare.games.forGame({
  appId: 'your-studio-product-uuid',
  groupId: 'your-credit-group-uuid',
});
const startParams = { clientBuildId: 'web-2026-10-06' };
let displayedTerms: Awaited<ReturnType<typeof paidGame.getTerms>> | undefined;
let pendingAttempt: {
  idempotencyKey: string;
  fingerprint: string;
  expectedCredits: number;
  clientBuildId: string;
} | undefined;

connectButton.addEventListener('click', async () => {
  await paidGame.connect(); // Explicit initial connection or renewal only.
  displayedTerms = await paidGame.getTerms();
  termsText.textContent = `${displayedTerms.title}: ${displayedTerms.credits} credits per play`;
  playButton.textContent = `Play — spend ${displayedTerms.credits} credits`;
});

playButton.addEventListener('click', async () => {
  if (displayedTerms === undefined || pendingAttempt !== undefined) return;
  pendingAttempt = {
    ...startParams,
    idempotencyKey: crypto.randomUUID(),
    fingerprint: JSON.stringify(startParams),
    expectedCredits: displayedTerms.credits,
  };
  // Retain this caller-owned key and exact confirmed binding while unresolved.
  // requestConsent saves the attempt before issuance and its consent before start.
  const { consent, recovery } = await paidGame.requestConsent(pendingAttempt);
  if (recovery === 'memory') {
    recoveryText.textContent = 'Keep this page open: reload recovery is unavailable.';
  }
  const started = await paidGame.startWithConsent({ ...pendingAttempt, consent });
  pendingAttempt = undefined; // Clear only after an observed successful start.
  // Use started.session to run this play; do not expose its token in the UI/logs.
});

recoverButton.addEventListener('click', async () => {
  if (pendingAttempt === undefined) return;
  const started = await paidGame.recoverStart(pendingAttempt);
  pendingAttempt = undefined;
  // This recovers the original play, not a new round.
});
```

Attach error handling to these handlers in your game (see the vanilla example). Keep the caller-owned attempt key available for `recoverStart({ idempotencyKey })`, including across reloads when recovery storage works. `requestConsent` returns `recovery: 'persistent' | 'memory'`: persistent means the SDK saved the attempt/consent for recovery; disabled or failing storage falls back to memory and requires keeping the same client/page alive. Persist the caller's non-secret key separately; never put authorization, consent, or session credentials in URLs or logs. `recoverStart` also retries a saved consent issuance whose response was lost, using the current game authorization without opening a window. It preserves the original start parameters, fingerprint, and confirmed cost.

Cancellation or window closure rejects `connect()` with `GameConnectionError` code `cancelled`; expiry rejects with `expired` or `authorization_required`. Stop and require another explicit **Connect game** click—never connect or spend automatically. Logout/account changes discard cached authorization. If they happen while `connect()` is pending, that attempt cannot authorize the replacement session; another explicit **Connect game** click starts a fresh connection. Consent issuance HTTP failures reject with `SuperRareConnectApiError`; inspect `error.status` and its optional structured `error.code`, not message text, to distinguish Studio rejections. A `401` clears cached authorization and requires explicit reconnection before recovering the same attempt. There is no automatic HTTP retry.

On `409 CREDIT_GROUP_COST_CHANGED`, no new consent was issued: refresh terms, show the new cost, and obtain a fresh visible confirmation before creating a new attempt. Never silently accept a higher cost. `409 CREDIT_GROUP_CONSENT_EXPIRED` proves a matched consent expired unused; only a fresh explicit confirmation may create a new attempt/key. A reused-key binding error must not be repaired by silently creating a key. After a timeout, network failure, or `503`, retain the original attempt and use **Recover original play**; do not create a second key or assume a charge failed. A completed/inactive session may reject recovery with `409`; do not replay a completed round.

The short-lived, one-use consent is bound to the app, group, origin, request, wallet account, and configured cost. Consent issuance itself does not reserve or deduct credits. Studio reserves before initializing the real game session, captures exactly once after initialization, releases only a definite initialization failure, and leaves timeouts or unknown outcomes reserved for reconciliation. A ready or terminal play is never automatically refunded. The returned `PlaySession` is narrow and game-bound; broad Connect access/refresh credentials remain on Studio.

Client-provided scores are deliberately named `submitClientAssertedScore`. They are session-bound assertions, not trusted or server-validated results:

```ts
await game.submitClientAssertedScore({
  sessionToken: started.session.token,
  score: 12500,
  idempotencyKey: crypto.randomUUID(),
});

const run = await game.startServerValidatedRun({
  sessionToken: started.session.token,
  eventId: 'studio-scoring-event-uuid',
  idempotencyKey: crypto.randomUUID(),
});
// Send supported run inputs to run.run.webSocketUrl. Studio's verifier owns
// authoritative calculation and records the verified result.
```

Leaderboard reads use the same game client:

```ts
const leaders = await game.getLeaderboard({ leaderboardKey: 'default', limit: 25 });
const mine = await game.getMyBest({ sessionToken: started.session.token });
await game.complete({ sessionId: started.session.id, sessionToken: started.session.token });
```

With a `groupId`, `game.credits` exposes balance and the real quote/claim/recovery endpoints. The SDK does not fabricate a USDC transfer method: send the exact quoted transfer with a wallet separately, then pass its transaction hash to `claimPurchase`. Retrying the same quote/hash is safe.

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

Every action except `transfer` accepts an optional `payment` hint (transfers are wallet-only, see [Transfers](#transfers); Liquid Edition trades accept only `{ method: 'wallet' }`, see [Liquid Editions](#liquid-editions)). Set `payment: { method: 'wallet' }` to keep the hosted checkout wallet-only: the hosted page never offers card payment, and Rare API refuses card preparation for the intent.

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

## Liquid Editions

A Liquid Edition is an ERC-20 token traded against a Uniswap v4 pool through SuperRare's LiquidRouter. `actions.buy` with a `liquid-edition` target spends an exact amount of ETH, RARE, or USDC and receives at least a minimum of the edition's token. `actions.sell` delivers an exact amount of the token and receives at least a minimum of ETH, RARE, or USDC. The hosted window re-quotes the trade, asks for the ERC-20 approval when paying or selling a token, and submits the trade from the connected wallet.

Amounts are raw base-unit strings: 18 decimals for the Liquid Edition token, ETH, and RARE (`'10000000000000000'` is 0.01), 6 decimals for USDC (`'25000000'` is 25 USDC). The SDK rejects decimals, zero, and leading zeros with `ConnectActionValidationError` before any window opens.

```ts
import type { ConnectLiquidEditionTarget } from '@rareprotocol/connect';

const liquidEdition: ConnectLiquidEditionTarget = {
  kind: 'liquid-edition',
  chainId: 1,
  contract: '0x…', // the Liquid Edition token
};

// Buy: spend exactly this much, receive at least the pinned minimum of the token.
await superrare.actions.buy({
  target: liquidEdition,
  spend: { currency: 'ETH', amount: '10000000000000000' }, // 0.01 ETH
  returnPath: '/liquid/complete',
});

await superrare.actions.buy({
  target: liquidEdition,
  spend: { currency: 'RARE', amount: '25000000000000000000' }, // 25 RARE
  maxSlippageBps: 100, // accept up to 1% below the quote
});

await superrare.actions.buy({
  target: liquidEdition,
  spend: { currency: 'USDC', amount: '25000000' }, // 25 USDC
});

// Sell: deliver exactly this much of the token, receive at least the pinned minimum.
await superrare.actions.sell({
  target: liquidEdition,
  sell: { amount: '40000000000000000000' }, // 40 tokens
  receive: { currency: 'ETH' },
});

await superrare.actions.sell({
  target: liquidEdition,
  sell: { amount: '40000000000000000000' },
  receive: { currency: 'RARE' },
  minReceived: '270000000000000000000', // at least 270 RARE
});

await superrare.actions.sell({
  target: liquidEdition,
  sell: { amount: '40000000000000000000' },
  receive: { currency: 'USDC' },
  minReceived: '60000000', // at least 60 USDC
});
```

The minimum received is pinned when the intent is created. Rare API quotes the whole route on-chain and stores the result in the intent's resolved terms: `amount` and `currency` are what the user delivers (for a sell, `currency` is the token address), `outputCurrency`, `estimatedAmountOut`, and `minAmountOut` are what they receive. The hosted window refuses to submit when the live quote has fallen below `minAmountOut`, and the router reverts the whole trade rather than deliver less, so the user never receives less than that minimum.

- Without `minReceived`, the minimum is the quote less `maxSlippageBps`: an integer from `1` to `500` basis points, default `50` (0.5%), maximum `500` (5%).
- With `minReceived` (base units of what the user receives: the token for a buy, the receive currency for a sell), it is the minimum as given and `maxSlippageBps` does not apply. Rare API refuses a `minReceived` above the live quote with `TERMS_STALE` (409), and one more than 5% below it with `INVALID_REQUEST` (400); both reject the call with `SuperRareConnectApiError`.

Liquid Edition trades are wallet-only: `payment` accepts only `{ method: 'wallet' }` (TypeScript rejects `'card'`), and Rare API refuses card payment for these intents with `INVALID_REQUEST`.

Liquid Editions trade on Ethereum mainnet (`chainId: 1`) and Sepolia (`11155111`). Production Connect executes mainnet only; for Sepolia use the dev `apiUrl`/`connectUrl` pair in [Testing on Sepolia](#testing-on-sepolia) with a `liquid-edition` target on `chainId: 11155111`.

## Transfers

`actions.transfer` asks the user to send an exact amount of ETH or USDC from their wallet to a wallet you name, for example to pay for off-chain goods such as game credits. The user signs in and confirms in the hosted window, which shows the amount, the network, and the full destination address before anything is sent.

```ts
await superrare.actions.transfer({
  chainId: 1,
  to: '0x52908400098527886E0F7030069857D2E4169EE7',
  currency: 'USDC',
  amount: '25000000', // 25 USDC
  returnPath: '/credits/complete',
  beforeOpen: async ({ intentId }) => {
    const response = await fetch('/api/orders/order_123/transfer-intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intentId }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('Could not link the payment to the order.');
  },
});
```

`beforeOpen` runs after the intent is created and before the hosted window shows the transfer. The window stays blank until `beforeOpen` resolves, so bound its work with a timeout. If `beforeOpen` throws, the SDK closes the window and `actions.transfer` rejects with that error, so the hosted window never shows a transfer your backend has not recorded.

- Chains: Ethereum mainnet (`1`), Base (`8453`), Sepolia (`11155111`) and Base Sepolia (`84532`) are supported; each hosted Connect deployment enables a subset. Production executes mainnet only; for Sepolia use the dev `apiUrl`/`connectUrl` pair in [Testing on Sepolia](#testing-on-sepolia). On a chain the deployment does not enable, the hosted window shows the transfer as not available.
- Currencies: `ETH` and `USDC`.
- `amount` is a raw base-unit string, like bid and offer amounts: wei for ETH (`'50000000000000000'` is 0.05 ETH) and 6 decimals for USDC (`'25000000'` is 25 USDC). The SDK rejects decimals, zero, leading zeros, and non-string amounts with `ConnectActionValidationError` (`code: 'invalid_amount'`) before any window opens.
- `to` must be a `0x`-prefixed, 40-hex-character address other than the zero address; the SDK rejects anything else with `ConnectActionValidationError` (`code: 'invalid_address'`) before any window opens.
- Wallet-only: there is no `payment` option and the hosted window never offers card. The user pays from the wallet they sign in with, and the hosted window keeps the confirm button disabled while that wallet cannot cover the amount.
- Rare API rejects the call with `SuperRareConnectApiError` (`status` 400) for a chain outside those four, an invalid or zero address as `to`, an unknown currency, or a card payment or `payment.recipient` sent to the API directly.
- Rare API accepts transfer intents on all four chains in every deployment, so a testnet intent created against production can still be completed by calling the API directly. Always compare `terms.chainId` with the order.

### Verifying a transfer before crediting

The user controls the page, so nothing it reports proves a payment: not the `actions.transfer` result, not `onIntentSettled`, and never an amount or chain sent from the page. Grant goods only from your backend, based on the intent it reads itself:

1. The page calls `actions.transfer` and sends the `intentId` to your backend from `beforeOpen`, as in the example above. The backend records it against the pending order: player, product, and the expected `recipient`, `amount`, `currency`, and `chainId`. Always create the intent from the page: SDK actions need a page, and the SDK cannot open an intent it did not create.
2. Treat `onIntentSettled` only as a hint to check. The backend reads the intent itself with `GET /v1/connect/intents/:intentId`, or with `intents.get` server-side.
3. Credit only when all of these hold:
   - `status === 'completed'`. A `processing` intent can already carry an unverified `result.transactionHash`; never credit it.
   - `resolvedActionSnapshot.actionType === 'transfer'`.
   - The terms `chainId`, `recipient`, `amount`, and `currency` equal the order's. `recipient` comes back checksummed, so compare addresses case-insensitively. A testnet transfer (Sepolia or Base Sepolia) must never credit a mainnet order, and a Base transfer must never credit an Ethereum order.
   - The `intentId` was not credited before, for example with a unique constraint on the column that stores credited intent ids. `isTransferPaid` below checks everything else.

```ts
import { createSuperRareClient } from '@rareprotocol/connect';

const superrare = createSuperRareClient({ sessionStorage: false });

type TransferOrder = {
  intentId: string;
  chainId: 1 | 8453 | 11155111 | 84532;
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

`intent.type` and the snapshot's `actionType` and `targetKind` can carry values added to Rare API after your SDK version, so handle an unrecognized value instead of assuming the list is closed.

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
      // Deliver every `message` event as { origin, data, source }; return the
      // unsubscribe function. Games verify source against their opened window.
      subscribe: (listener) => {
        const handler = (event: MessageEvent) => {
          listener({ origin: event.origin, data: event.data, source: event.source });
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

await superrare.auth.logout();
unsubscribe();
```

`getSession()` is a synchronous, cached local snapshot for UI state. It is not
server verification and may contain an expired access token. Login results and
session-change callbacks contain access-session identity only, never refresh
credentials.

### Authenticated Calls To Your Backend

Ask the SDK for an access token immediately before an authenticated request:

```ts
const token = await superrare.auth.getAccessToken();
const response = await fetch('/api/game/score', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ score }),
});
```

Your backend verifies the token with Rare API's `GET /v1/connect/session` and
uses the returned identity. A browser-supplied score still needs game-specific
validation; authentication alone does not authorize transfers.

`getAccessToken()`, `auth.getRemoteSession()`, `auth.me()`, and `user.me()`
automatically renew access when it expires or has at most 60 seconds remaining.
Renewal happens on demand, not through background timers. Access lasts up to
one hour; the refresh session has a fixed 30-day maximum from login. Callers do
not manually manage refresh credentials. `getAccessToken()` and `me()` throw
`ConnectSessionRequiredError` when there is no usable local session.

Deploy the refresh-capable Rare API before upgrading this SDK: login exchange
must return both access and refresh credentials, and refresh/logout endpoints
must be available. Access-only exchange responses are rejected.

The SDK persists credentials in browser local storage by default, restoring
them across page loads. `sessionStorage: false` or blocked storage uses memory
only; a page reload then requires login again. Storage is scoped to the app
origin and Rare API environment. The production API uses
`superrare.connect.session`; other API origins append `:` plus the
URL-encoded API origin. `sessionStorageKey` replaces the base key. Old
access-only storage records cannot renew and require a new login.

Clients sharing the same storage object and key coordinate one renewal.
Browsers with Web Locks also coordinate across tabs and re-read credentials
inside the lock. Without Web Locks, separate tabs can race a single-use refresh
credential, so an affected tab may need to sign in again.

A refresh HTTP 401 clears the matching local session. Network errors and HTTP
503 propagate without treating an outage as logout. Refresh requests are not
automatically replayed: a lost response may have consumed the credential.

`await auth.logout()` revokes the current refresh session and all its access
tokens on Rare API. Local identity disappears immediately; persisted deletion
may wait for an in-flight renewal or browser lock so logout can revoke the
replacement credential. Revocation failures are reported to the caller.
`auth.clearSession()` only clears local state and does not revoke server
credentials. Neither method signs out the separate hosted Connect login cookie.

Refresh credentials are private SDK state and are sent only to Rare API, never
to your game backend. Browser persistence remains accessible to JavaScript:
protect the app against XSS and never log stored credentials or put them in URLs.
Use HTTPS outside local development.

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

Every hosted flow — checkout, buy, sell, bid, mint, settle, transfer, offers, and login — opens in a small centered window, the way wallet and social sign-in flows behave, so your page keeps its state while the buyer pays. `popup` shapes that window and `onIntentSettled` reports how the flow ended:

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
- `ConnectActionValidationError` for action parameters the SDK rejects before creating an intent, with `code` `invalid_amount`, `invalid_address`, `invalid_min_received`, or `invalid_max_slippage_bps`.
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
