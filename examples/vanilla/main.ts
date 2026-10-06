import {
  createSuperRareClient,
  GameConnectionError,
  SuperRareConnectApiError,
  type GameCreditTerms,
} from '../../src/index.js';

const params = new URLSearchParams(location.search);
const superrare = createSuperRareClient({
  apiUrl: 'http://localhost:3000',
  studioUrl: params.get('studioUrl') ?? 'http://localhost:5173',
});
const output = document.querySelector('#output');
const termsText = document.querySelector('#game-terms');
const recoveryText = document.querySelector('#game-recovery');
const connectGame = document.querySelector<HTMLButtonElement>('#connect-game');
const playGame = document.querySelector<HTMLButtonElement>('#play-game');
const recoverGame = document.querySelector<HTMLButtonElement>('#recover-game');
const appId = params.get('appId');
const groupId = params.get('groupId');
const game = appId !== null && groupId !== null ? superrare.games.forGame({ appId, groupId }) : undefined;
const attemptStorageKey = `vanilla-game-attempt:${appId}:${groupId}`;
let terms: GameCreditTerms | undefined;
let connectedUntil = 0;
let busy = false;
let pendingKey: string | undefined;
let callerStorageWorks = true;

const render = (value: unknown): void => {
  if (output !== null) output.textContent = JSON.stringify(value, null, 2);
};
const noteRecovery = (message: string): void => {
  if (recoveryText !== null) recoveryText.textContent = message;
};

// Persist only the caller-owned key here. The SDK owns saved start/consent recovery.
try {
  const saved = sessionStorage.getItem(attemptStorageKey);
  if (saved !== null && /^[0-9a-f-]{36}$/i.test(saved)) pendingKey = saved;
} catch {
  callerStorageWorks = false;
}

const retainKey = (key: string | undefined): void => {
  pendingKey = key;
  try {
    if (key === undefined) sessionStorage.removeItem(attemptStorageKey);
    else sessionStorage.setItem(attemptStorageKey, key);
  } catch {
    callerStorageWorks = false;
  }
};
const updateControls = (): void => {
  if (connectGame !== null) connectGame.disabled = busy || game === undefined;
  if (playGame !== null) {
    playGame.disabled = busy || game === undefined || terms === undefined || pendingKey !== undefined || Date.now() >= connectedUntil;
    playGame.textContent = terms === undefined ? 'Play — load terms first' : `Play — spend ${terms.credits} credits`;
  }
  if (recoverGame !== null) recoverGame.disabled = busy || pendingKey === undefined || game === undefined;
};
const loadTerms = async (): Promise<void> => {
  if (game === undefined) return;
  terms = undefined;
  updateControls();
  const next = await game.getTerms();
  terms = next;
  if (termsText !== null) termsText.textContent = `${next.title}: one play costs ${next.credits} credits. Confirm below to spend.`;
};
const handlePaidError = async (error: unknown, issuingConsent = false): Promise<void> => {
  if (error instanceof GameConnectionError) {
    connectedUntil = 0;
    render({ error: error.code, action: 'Connection stopped. Click Connect game explicitly; no play was started by connecting.' });
    return;
  }
  if (error instanceof SuperRareConnectApiError) {
    if (error.status === 401) {
      connectedUntil = 0;
      render({ error: 'Authorization required. Click Connect game, then recover the original attempt if one is pending.' });
      return;
    }
    const costChanged = issuingConsent && error.status === 409 && error.code === 'CREDIT_GROUP_COST_CHANGED';
    const expiredUnused = error.status === 409 && error.code === 'CREDIT_GROUP_CONSENT_EXPIRED';
    if (costChanged || expiredUnused) {
      // These rejections prove no new consent/unused consent respectively.
      // Refresh the displayed price; the next Play click is a fresh confirmation.
      retainKey(undefined);
      terms = undefined;
      render({ error: costChanged ? 'Cost changed. Review refreshed terms and confirm again.' : 'Unused consent expired. Review terms and confirm again.' });
      try { await loadTerms(); } catch { render({ error: 'Could not refresh terms. Click Connect game to load terms again.' }); }
      return;
    }
    render({ error: `Studio rejected the request (${error.status}).`, action: 'Keep the original attempt. Do not silently create a new key or replay a completed round.' });
    return;
  }
  // Do not print credentials or arbitrary response bodies.
  render({ error: 'No confirmed response. Keep this page and recover the original attempt; do not start a second play.' });
};

// Hosted windows must be opened directly from a click. Paid consent/start never open one.
document.querySelector('#login')?.addEventListener('click', () => {
  void superrare.auth.login()
    .then((result) => render({ status: result.status }))
    .catch(() => render({ error: 'Login failed.' }));
});
document.querySelector('#buy')?.addEventListener('click', () => {
  void superrare.actions.buy({
    target: {
      kind: 'erc721-direct-listing', chainId: 11155111,
      contract: '0x252f829f6ea6623c883d6f433dc6999b94817419', tokenId: '1',
    },
    expected: { currency: 'ETH', price: '1000000000000' },
  }).then(() => render({ status: 'Buy flow opened.' })).catch(() => render({ error: 'Buy flow failed.' }));
});
document.querySelector('#start-free-game')?.addEventListener('click', () => {
  if (appId === null) return render({ error: 'Add ?appId=<Studio product UUID> to the URL.' });
  void superrare.games.forGame({ appId }).start({ idempotencyKey: crypto.randomUUID() })
    .then((started) => render({ sessionId: started.session.id }))
    .catch(() => render({ error: 'Free start failed.' }));
});

connectGame?.addEventListener('click', async () => {
  if (game === undefined || busy) return;
  busy = true;
  updateControls();
  try {
    const authorization = await game.connect();
    connectedUntil = Date.parse(authorization.expiresAt);
    window.setTimeout(updateControls, Math.max(0, connectedUntil - Date.now()));
    await loadTerms();
    render({ status: 'Game connected. Review the terms; connecting does not spend credits.' });
  } catch (error) {
    await handlePaidError(error);
  } finally {
    busy = false;
    updateControls();
  }
});

playGame?.addEventListener('click', async () => {
  if (game === undefined || terms === undefined || busy || pendingKey !== undefined) return;
  if (Date.now() >= connectedUntil) {
    render({ error: 'Connection expired. Click Connect game explicitly before confirming a play.' });
    updateControls();
    return;
  }
  // The key is created only by this explicit displayed-cost confirmation.
  const startParams = { clientBuildId: 'vanilla-web-2026-10-06' };
  const attempt = {
    ...startParams,
    idempotencyKey: crypto.randomUUID(),
    fingerprint: JSON.stringify(startParams),
    expectedCredits: terms.credits,
  };
  retainKey(attempt.idempotencyKey);
  busy = true;
  updateControls();
  let issuingConsent = true;
  try {
    const { consent, recovery } = await game.requestConsent(attempt);
    noteRecovery(recovery === 'persistent' && callerStorageWorks
      ? 'Original attempt saved for recovery. Recover never starts a new round.'
      : 'Memory recovery only: keep this page open. Reload recovery is unavailable.');
    issuingConsent = false;
    const started = await game.startWithConsent({ ...attempt, consent });
    retainKey(undefined);
    render({ sessionId: started.session.id, status: 'Original play started.' });
  } catch (error) {
    noteRecovery('Keep the original attempt and this page open. Use Recover original play; never create a replacement key for an unknown response.');
    await handlePaidError(error, issuingConsent);
  } finally {
    busy = false;
    updateControls();
  }
});

recoverGame?.addEventListener('click', async () => {
  if (game === undefined || pendingKey === undefined || busy) return;
  busy = true;
  updateControls();
  try {
    // Saved params, confirmed cost/fingerprint, and consent remain unchanged.
    // Lost issuance is retried with current authorization; no popup or new key.
    const started = await game.recoverStart({ idempotencyKey: pendingKey });
    retainKey(undefined);
    render({ sessionId: started.session.id, status: 'Original play recovered, not a new round.' });
  } catch (error) {
    await handlePaidError(error, true);
  } finally {
    busy = false;
    updateControls();
  }
});

superrare.auth.onChange(() => {
  connectedUntil = 0;
  updateControls();
});
if (pendingKey !== undefined) noteRecovery('An unresolved attempt is saved. Recover the original play; explicitly reconnect first only if authorization is required.');
if (game === undefined) render({ error: 'For paid games add ?appId=<UUID>&groupId=<UUID>&studioUrl=<Studio origin>.' });
updateControls();
