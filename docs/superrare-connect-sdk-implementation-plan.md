# SuperRare Connect SDK Implementation Plan

**Status:** Draft  
**Last updated:** June 19, 2026  
**Target repo:** new public repository  
**Package:** `@superrare/connect`

## Goal

Build a small public browser SDK that lets any website start SuperRare-hosted login, checkout, and supported transaction flows without integrating Reown, wagmi, Coinflow, viem wallet clients, RPC providers, or contract ABIs.

The SDK is not the wallet implementation. It is a typed controller for:

- creating intents through Rare API
- opening `connect.superrare.com`
- enforcing same-origin `returnPath` usage
- tracking state
- polling status
- exposing limited session and user helpers

All sensitive auth, wallet, payment, and contract work happens on SuperRare-controlled origins.

## Non-Goals

- No Reown or wagmi dependency.
- No Coinflow dependency.
- No direct contract writes.
- No arbitrary calldata support.
- No React dependency in the core package.
- No Node-only SDK behavior in V1.
- No app registration or `clientId` model in V1.

## Package Shape

Recommended repo structure:

```txt
superrare-connect/
  package.json
  tsconfig.json
  tsup.config.ts
  vitest.config.ts
  README.md
  src/
    index.ts
    client.ts
    config.ts
    http.ts
    auth.ts
    checkout.ts
    actions.ts
    intents.ts
    popup.ts
    return-path.ts
    state.ts
    status.ts
    errors.ts
    types.ts
  test/
    return-path.test.ts
    state.test.ts
    popup-url.test.ts
    client.test.ts
  examples/
    vanilla/
      index.html
      main.ts
    react/
      package.json
      src/App.tsx
```

## Package Metadata

Package name:

```json
{
  "name": "@superrare/connect",
  "type": "module",
  "sideEffects": false
}
```

Exports:

```json
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  }
}
```

Build targets:

- ESM
- CJS, if needed for compatibility
- Type declarations
- Browser-compatible output

Recommended tooling:

- `typescript`
- `tsup`
- `vitest`
- `eslint`
- `prettier`
- later: `openapi-typescript` or `openapi-fetch`

## Public API

V1 should be intentionally small:

```ts
import { createSuperRareClient } from "@superrare/connect"

const superrare = createSuperRareClient()

await superrare.auth.login({
  returnPath: "/account",
})

const session = await superrare.auth.getSession()
const user = await superrare.user.me()

await superrare.checkout.start({
  listingId: "listing_123",
  returnPath: "/thanks",
})

const checkout = await superrare.checkout.getStatus({
  sessionId: "checkout_session_123",
})

await superrare.actions.bid({
  listingId: "listing_123",
  amount: "1.2",
  currency: "ETH",
  returnPath: "/bid/complete",
})
```

## Client Options

```ts
export type SuperRareClientOptions = {
  apiUrl?: string
  connectUrl?: string
  openMode?: "popup" | "redirect" | "new-tab"
  fetch?: typeof fetch
}
```

Defaults:

```ts
const defaultOptions = {
  apiUrl: "https://api.superrare.com",
  connectUrl: "https://connect.superrare.com",
  openMode: "popup",
}
```

The options are mainly for sandbox, local development, and testing.

## Core Types

```ts
export type LoginParams = {
  returnPath?: string
  openMode?: OpenMode
}

export type CheckoutStartParams = {
  listingId: string
  returnPath?: string
  openMode?: OpenMode
}

export type BidActionParams = {
  listingId: string
  amount: string
  currency: string
  returnPath?: string
  openMode?: OpenMode
}

export type ConnectIntentStatus =
  | "pending"
  | "requires_user"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired"

export type ConnectSession =
  | {
      authenticated: true
      address: string
      expiresAt: string
    }
  | {
      authenticated: false
    }
```

## Same-Origin Return Path Rules

The SDK should expose `returnPath`, never `returnUrl`.

Valid:

```ts
returnPath: "/thanks"
returnPath: "/checkout/complete?listing=123"
```

Invalid:

```ts
returnPath: "https://evil.com"
returnPath: "//evil.com"
returnPath: "\\evil.com"
returnPath: "javascript:alert(1)"
```

SDK validation should catch obvious mistakes before calling the API. Rare API remains the authority and repeats validation server-side.

Client helper:

```ts
export function normalizeReturnPath(value?: string): string
```

Behavior:

- default to current path or `/` depending on method needs
- require leading `/`
- reject protocol-relative paths
- reject full URLs
- reject backslashes
- reject control characters
- preserve valid query strings and hash if needed

## Intent Flow

All hosted flows use the same intent creation path.

SDK steps:

1. Normalize `returnPath`.
2. Generate random `state`.
3. Call `POST /v1/connect/intents`.
4. Receive `{ data: { intentId, url, expiresAt } }`.
5. Open `url` with selected open mode.
6. Poll `GET /v1/connect/intents/{intentId}` or wait for `postMessage`.
7. Resolve or reject based on confirmed status.

The SDK should never treat redirect URL params alone as proof of success.

## Auth Module

Methods:

```ts
auth.login(params?: LoginParams): Promise<LoginResult>
auth.getSession(): Promise<ConnectSession>
auth.logout(): Promise<void>
auth.onChange(callback: (session: ConnectSession) => void): () => void
```

V1 `logout()` can clear SDK-local state and optionally open a hosted logout flow later.

`login()` creates a `login` intent:

```json
{
  "action": { "type": "login" },
  "returnPath": "/account",
  "state": "..."
}
```

After hosted login, the SDK exchanges the code/result through:

```txt
POST /v1/connect/auth/exchange
```

## User Module

Methods:

```ts
user.me(): Promise<ConnectUser | null>
user.getProfile(params: { address: string }): Promise<ConnectUser | null>
```

V1 can start with `me()` only if profile-by-address already exists through the broader Rare API client.

## Checkout Module

Methods:

```ts
checkout.start(params: CheckoutStartParams): Promise<CheckoutStartResult>
checkout.getStatus(params: { sessionId: string }): Promise<CheckoutStatus>
```

`checkout.start()` creates an intent:

```json
{
  "action": { "type": "checkout", "listingId": "listing_123" },
  "returnPath": "/thanks",
  "state": "..."
}
```

## Actions Module

Methods:

```ts
actions.bid(params: BidActionParams): Promise<ActionResult>
actions.open(params: { intentId: string; url: string; openMode?: OpenMode }): Promise<ActionResult>
actions.getStatus(params: { intentId: string }): Promise<ConnectIntent>
```

Only implement action-specific helpers as Rare API supports them.

Unsupported actions should fail at compile time when possible and at runtime with a clear SDK error otherwise.

## Window Opening

`openMode` behavior:

- `popup`: default, opens centered popup and polls status
- `redirect`: sets `window.location.href`
- `new-tab`: opens `_blank`

Popup rules:

- open synchronously in direct response to a user gesture when possible
- if popup is blocked, throw `PopupBlockedError`
- expose fallback guidance in error metadata
- listen for `postMessage` from `connect.superrare.com`
- still poll status because `postMessage` is a UX signal, not final truth

## Errors

Use catchable SDK error classes:

```ts
SuperRareConnectError
InvalidReturnPathError
PopupBlockedError
IntentExpiredError
IntentFailedError
ApiRequestError
```

Error objects should include:

- `code`
- `message`
- optional `status`
- optional `details`

## HTTP Client

Implement a small fetch wrapper:

```ts
async function requestJson<TResponse, TBody = undefined>(
  options: RequestJsonOptions<TBody>,
): Promise<TResponse>
```

Responsibilities:

- join `apiUrl` and path safely
- set JSON headers
- include credentials only if needed and explicitly decided
- parse JSON as `unknown`
- validate minimal response shape
- throw `ApiRequestError` on non-2xx

The SDK can switch to generated OpenAPI types after Rare API contracts stabilize.

## Script Tag Bundle

V1 or V1.1 should provide a global build:

```html
<script src="https://connect.superrare.com/sdk.js"></script>
<button
  data-superrare-checkout
  data-listing-id="listing_123"
  data-return-path="/thanks"
>
  Buy with SuperRare
</button>
```

Global:

```ts
window.SuperRareConnect
```

Auto-binding behavior:

- scan for `[data-superrare-checkout]`
- attach click handlers
- read `data-listing-id`
- read `data-return-path`
- call `checkout.start(...)`

Do not make the script-tag bundle mandatory for the npm SDK.

## Testing Plan

Unit tests:

- return path normalization
- state generation and validation
- popup URL construction
- API error handling
- status polling behavior

Browser tests:

- popup opened from user gesture
- popup blocked path
- `postMessage` handling
- redirect mode URL generation

Integration tests:

- against a local Rare API fixture server
- contract tests against OpenAPI examples once available

Security tests:

- reject full redirect URLs
- reject protocol-relative return paths
- reject backslashes
- reject control characters
- do not resolve success from URL params alone

## Phased Work

### Phase 1: Package Skeleton

- create public repo
- add TypeScript, tsup, vitest
- implement `createSuperRareClient`
- implement config defaults
- implement return path validation
- add unit tests

Exit criteria:

- package builds
- tests pass
- README has minimal login/checkout examples

### Phase 2: Intent Client

- implement Rare API fetch wrapper
- implement `createIntent`
- implement `getIntent`
- implement popup/new-tab/redirect opener
- implement polling

Exit criteria:

- SDK can open a hosted intent URL from a fixture API

### Phase 3: Auth And User

- implement `auth.login`
- implement `auth.getSession`
- implement `auth.onChange`
- implement `user.me`

Exit criteria:

- hosted login fixture flow can return session/user data

### Phase 4: Checkout

- implement `checkout.start`
- implement `checkout.getStatus`
- add examples

Exit criteria:

- vanilla example starts checkout and renders confirmed status

### Phase 5: Actions

- implement first supported action helper, likely `actions.bid`
- add action status helpers
- document supported action set

Exit criteria:

- first supported action works through same intent flow

### Phase 6: Script Tag Bundle

- add browser global build
- add data-attribute auto binding
- publish `sdk.js` artifact strategy

Exit criteria:

- static HTML page can add a checkout button with no build step

## Documentation

README sections:

- install
- quick start
- login
- checkout
- supported actions
- return paths and same-origin safety
- popup vs redirect
- errors
- local/sandbox configuration

## Open Decisions

- Generate API types immediately from OpenAPI, or start with hand-written request/response types?
- Should `auth.getSession()` use local SDK state, Rare API, or both?
- What is the first non-checkout action helper?
- Should popup polling timeout be configurable?
- What URL will host the script-tag bundle?
