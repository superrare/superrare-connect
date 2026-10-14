## Target game reference

This plain-JavaScript example uses the built SDK browser bundle from this repository and serves only its allowlisted files on loopback. It can also produce a portable static archive with root `index.html`, `config.json`, the complete SDK bundle, and versioned JS/CSS assets. It demonstrates explicitly selected embedded or popup hosted Connect sign-in/checkout, headless scoped Studio game authorization, account-bound credit state, explicit purchase confirmation, and paid-round recovery.

### Requirements

- Node.js 22.6 or newer and pnpm.
- A built SDK bundle (`pnpm build` creates `dist/superrare-connect.global.js`).
- Your own approved Studio app and credit group, with the exact browser origin approved for both. The game uses `location.origin`; changing hostname or port requires the new origin to be approved in Studio.
- Environment-specific Studio, Rare API, and Connect base URLs. `studioUrl` is the Studio API origin; it is not the Rare API or Connect host.
- Beta access for Studio game/credit APIs, where required by your environment.
- For static archive export: the system `zip` and `unzip` commands.

For local development, app ID, credit-group ID, service URLs, and hosted-flow display can be supplied in the page query string. On a published/non-loopback origin, the page loads the root `config.json` with `cache: "no-store"`; on loopback it loads that file only if the query configuration is incomplete. Explicit query values override the file, and any packaged `appOrigin` must match the current page origin. The example has no seeded app/group defaults and does not provide an identity, balance, quote, or payment fallback.

### Build and run

From the repository root:

```sh
pnpm install
pnpm build
pnpm example:target-game
```

`pnpm example:target-game` runs the loopback-only server on port 5174 and serves the repository-built `dist/superrare-connect.global.js` by default. To use a separately supplied SDK artifact for local development, pass `--sdk-bundle /path/to/superrare-connect.global.js` to `examples/target-game/serve.ts`; this override is optional and is not needed for a normal public clone.

The server prints `http://localhost:5174/examples/target-game/`. Open it with your approved app/group and environment configuration, for example:

```text
http://localhost:5174/examples/target-game/?appId=YOUR_STUDIO_APP_UUID&groupId=YOUR_CREDIT_GROUP_UUID&studioUrl=https%3A%2F%2Fstudio.example&apiUrl=https%3A%2F%2Fapi.example&connectUrl=https%3A%2F%2Fconnect.example&display=popup
```

`display=embed` explicitly selects the embedded hosted-flow adapter. For compatibility with Charles's tested setup, only the known dev-mainnet Connect origin defaults to embed when `display` is omitted; portable links should still set the choice explicitly. Production and other hosts require `display=embed` or `display=popup`. The production profile uses `display=embed`: a fresh valid-intent login page rendered inside an iframe from the approved production profile origin. This confirms the current intent/login surface can render; it does not confirm authentication or callback completion. No automatic popup fallback occurs if embedding is unavailable or the flow fails.

Charles's existing local integration URL is retained for his approved development setup only:

```text
http://localhost:5174/examples/target-game/?appId=53a9574d-6890-4dbd-a690-41540dd0f030&groupId=b7adb9bb-78f2-4738-a6b8-74cef7533c51&studioUrl=http%3A%2F%2Flocalhost%3A5173&apiUrl=https%3A%2F%2Frare-api-dev-mainnet.superrare.co&connectUrl=https%3A%2F%2Fconnect-dev-mainnet.superrare.co&display=embed
```

Those IDs and origins are not defaults for other developers; replace them with your own approved Studio app, credit group, and origin.

### Export a static profile

The export command creates a ZIP with `index.html` at the archive root, `config.json`, `connect-sdk.js`, and every required JavaScript/CSS module. Script and stylesheet URLs include SHA-256 cache-busting hashes. The archive contains no repository-relative SDK path, absolute workstation path, credentials, or example app/group IDs; the IDs and approved origin come only from your configuration file.

Create a private local JSON file for your own approved app, credit group, service origins, and published origin:

```json
{
  "appId": "YOUR_STUDIO_APP_UUID",
  "groupId": "YOUR_CREDIT_GROUP_UUID",
  "studioUrl": "https://studio.superrare.com",
  "apiUrl": "https://api.superrare.com",
  "connectUrl": "https://connect.superrare.com",
  "appOrigin": "https://your-game.srstudio.dev",
  "display": "embed"
}
```

The placeholder IDs and origin above must be replaced with values you own; do not upload the template unchanged. Production config must explicitly select `display: "embed"` or `display: "popup"`. This example's production profile selects embed because a fresh valid-intent login page rendered in an iframe from the approved profile origin, but authentication and callback completion were not tested. Embedded dev-mainnet testing remains available with `display: "embed"` when that host permits the approved game origin; there is no automatic transport fallback.

From the repository root, rebuild the SDK from the checked-out source and create the archive:

```sh
pnpm install
pnpm build
pnpm example:target-game:export -- --config /path/to/your-game-config.json --output /path/to/target-game.zip
```

The default SDK input is the checked-out `dist/superrare-connect.global.js`. To package another reviewed SDK artifact, add `--sdk-bundle /path/to/superrare-connect.global.js`. The exporter writes `sdkCommit` from the current Git head, requires origin-only HTTPS service URLs, an exact HTTPS `appOrigin`, and an explicit `display` selection; it enforces the hosting limits of 50 MB and 500 files. Existing output is not overwritten unless `--force` is supplied.

Upload the resulting ZIP with the platform's normal creator publishing flow. After any source or SDK change, rebuild the SDK and regenerate/re-upload the archive; the hosted origin must remain the same origin approved for the app. Confirm the selected credit group is on the intended chain and displays its real price before enabling purchases. This reference uses real Ethereum-mainnet USDC quotes and transfers; it never auto-spends, grants credits, or starts paid play.

### Flow and safety

The page restores and verifies the saved Connect session. **Sign in to SuperRare** opens hosted Connect using the selected transport. **Authorize game** calls `game.connect()` directly against the Studio API with the current Connect session and the browser origin; it does not open a Studio authorization popup. When signed out, authorization shows a sign-in-required state without a request; HTTP 401 exposes a retryable Connect session check or sign-in action without deleting credentials or pending game/purchase records.

Studio's authorization response must include the top-level ISO `issuedAt` timestamp. The SDK measures the maximum 15-minute authorization lifetime from that server-issued timestamp, not the browser's clock; local expiry, session-expiry, wallet, app/group, and origin checks still apply. Deploy the Studio producer change before rebuilding/uploading this SDK example. Existing saved game authorization and pending purchase/round records need no migration or clearing.

Successful game authorization is distinct from balance and round recovery. A balance refresh failure does not undo authorization. Each new round has a separate visible credit-cost confirmation. The confirmation or **Continue** action starts the game immediately after Studio returns its session; there is no second ready-to-play confirmation. Scores are client-asserted and are not server-verified.

Consent issuance and the initial paid start use the same saved request, including its session metadata. Omitting or changing that metadata causes the SDK to reject the start as `attempt_mismatch`. **Continue** first recovers the original SDK-persisted attempt with its existing idempotency key. If scoped game authorization has expired, this explicit action reconnects and checks that the wallet still owns the saved play.

An expired cached consent is checked with Studio. Only `409 CREDIT_GROUP_CONSENT_EXPIRED`, which proves the original attempt expired unused, allows the example to archive it and transparently start a replacement from the same **Continue** click. The current credit cost must still match the originally confirmed cost; a changed cost requires visible confirmation. Already-paid and ambiguous attempts keep their original key. Error details remain available in a collapsed panel, while sign-in, insufficient credits, pauses, and network failures show concise actions. No paid play or attempt replacement happens on page load or background refresh.

Replacement keys are deterministically derived from the expired unused attempt and its confirmed cost. Repeated recovery or another tab replacing that same unused attempt therefore reaches the same replacement play, rather than generating another independent charge.

Credit purchases use the real Studio quote and Ethereum-mainnet USDC transfer flow. The quote is saved before hosted checkout, but no transfer is submitted until the player explicitly confirms it in the hosted wallet. Cancellation, popup closure, a lost response, or an HTTP error does not prove payment did not occur; keep the same purchase, intent, and transaction hash and reconcile them before requesting another transfer. The example never clears an ambiguous purchase or starts a paid round automatically.

### Safe local smoke

1. Open the page with your own approved app, group, service URLs, origin, and explicit transport.
2. In a signed-out session, click **Authorize game** once. It should stay on the page, report that Connect sign-in is required, and open no Studio authorization window.
3. Sign in only through the hosted Connect control when authorized to do so. Do not use another person's browser/session or perform identity-provider, OTP, or wallet approval on their behalf.
4. After legitimate sign-in, use **Authorize game** to request the real scoped authorization. Stop before purchase confirmation or paid play unless the owner explicitly authorizes that boundary.
5. If the result is ambiguous, keep the same saved purchase and round records; do not clear storage or create a duplicate transfer/play attempt.

The server binds only to `127.0.0.1`, serves an explicit file allowlist, and does not expose the repository filesystem. Stop only the server you started. Do not deploy, merge, publish, release, grant credits, submit a payment, or start a paid round as part of this local smoke.
