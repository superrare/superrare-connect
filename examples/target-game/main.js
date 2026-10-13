import { Credits } from './credits.js';
import {
  createHostedConnectSurface,
  describeSdkFailure,
  deriveConnectSessionView,
  deriveGameAuthorizationView,
  resolveHostedDisplay,
} from './hosted-flow.js';
import { PaidRound } from './round.js';
const params = new URLSearchParams(location.search);
const appId = params.get('appId');
const groupId = params.get('groupId');
const studioUrl = params.get('studioUrl') ?? 'https://studio.superrare.com';
const apiUrl = params.get('apiUrl') ?? 'https://api.superrare.com';
const connectUrl = params.get('connectUrl') ?? 'https://connect.superrare.com';
const displayConfiguration = resolveHostedDisplay(params.get('display'), connectUrl);
const display = displayConfiguration.ok ? displayConfiguration.display : undefined;
const mainnetUsdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const embeddedConnectAvailable = typeof window.SuperRareConnect.ConnectEmbedUnavailableError === 'function';
const configText = document.querySelector('#configuration');
const signInButton = document.querySelector('#sign-in');
const signInStatus = document.querySelector('#connect-status');
const connectButton = document.querySelector('#connect');
const connectionStatus = document.querySelector('#connection-status');
const hostedDialog = document.querySelector('#hosted-connect-dialog');
const hostedCloseButton = document.querySelector('#close-hosted-connect');
const hostedStatus = document.querySelector('#hosted-connect-status');
const hostedFrameRoot = document.querySelector('#hosted-connect-frame');
const hostedSurface = createHostedConnectSurface({
  dialog: hostedDialog,
  frameRoot: hostedFrameRoot,
  status: hostedStatus,
});
let credits;
let round;
let busy = false;

if (!appId || !groupId) {
  connectionStatus.textContent = 'Add your Studio appId and credit groupId to the URL. See the example README.';
  signInButton.disabled = true;
  connectButton.disabled = true;
} else if (!displayConfiguration.ok) {
  const messages = {
    invalid_connect_url: 'Set a valid Connect base URL before choosing a hosted-flow display.',
    invalid_display: 'Set display=embed or display=popup.',
    production_embed_blocked: 'Production Connect currently denies iframe embedding. Set display=popup explicitly; this example never falls back automatically.',
    display_required: 'This Connect host requires an explicit display=embed or display=popup choice.',
  };
  signInButton.disabled = true;
  connectButton.disabled = true;
  signInStatus.textContent = 'Choose an explicit hosted-flow display for this Connect host.';
  connectionStatus.textContent = messages[displayConfiguration.reason];
} else {
  configText.textContent = `App ${appId} · credit group ${groupId} · Studio ${studioUrl} · Connect display ${display}`;
  const client = window.SuperRareConnect.createSuperRareClient({
    studioUrl,
    apiUrl,
    connectUrl,
    ...(display === 'embed' ? { embed: hostedSurface } : {}),
    onIntentSettled: (intent) => {
      credits?.onIntentSettled(intent);
      hostedStatus.textContent = `Hosted Connect reports ${intent.status}. The saved purchase is reconciled separately with Studio.`;
    },
  });
  const game = client.games.forGame({ appId, groupId });
  const baseKey = `superrare-target-game:${encodeURIComponent(studioUrl)}:${appId}:${groupId}`;
  let connectState = 'signed_out';
  let connectSession;
  let connectMessage;
  let connectCheckGeneration = 0;
  let connectExpiryTimer;
  let gameAuthorizationTimer;
  let gameAuthorizationAddress;

  const renderConnectState = () => {
    const view = deriveConnectSessionView(connectState, connectSession, Date.now());
    signInButton.textContent = view.buttonLabel;
    signInButton.disabled = busy || view.disabled;
    signInStatus.textContent = connectMessage ?? view.status;
  };

  const setConnectState = (state, session, message) => {
    connectState = state;
    connectSession = session;
    connectMessage = message;
    if (connectExpiryTimer !== undefined) {
      window.clearTimeout(connectExpiryTimer);
      connectExpiryTimer = undefined;
    }
    if (state === 'authenticated' && session) {
      const expiresAt = Date.parse(session.expiresAt);
      if (Number.isFinite(expiresAt) && expiresAt > Date.now()) {
        const delay = Math.min(expiresAt - Date.now(), 2_147_483_647);
        connectExpiryTimer = window.setTimeout(() => {
          void verifyConnectSession();
        }, delay);
      }
    }
    renderConnectState();
  };

  const verifyConnectSession = async (
    session = client.auth.getSession(),
    pendingMessage,
  ) => {
    if (!session) {
      connectCheckGeneration += 1;
      setConnectState('signed_out', undefined, pendingMessage);
      return;
    }
    const generation = ++connectCheckGeneration;
    setConnectState('checking', session, pendingMessage ?? 'Checking the saved SuperRare Connect session…');
    try {
      const remote = await client.auth.getRemoteSession();
      if (generation !== connectCheckGeneration) return;
      if (!remote.authenticated) {
        setConnectState(
          'signed_out',
          undefined,
          'The saved Connect session is no longer authenticated. Sign in again; saved game and purchase state was preserved.',
        );
        return;
      }
      const verifiedSession = remote.session ?? client.auth.getSession();
      if (!verifiedSession) {
        setConnectState(
          'verification_failed',
          session,
          'Connect confirmed a session without an expiry snapshot. Retry the session check; stored credentials were preserved.',
        );
        return;
      }
      setConnectState('authenticated', verifiedSession);
    } catch (error) {
      if (generation !== connectCheckGeneration) return;
      setConnectState(
        'verification_failed',
        session,
        `Could not verify the saved Connect session (${describeSdkFailure(error)}). Stored credentials were preserved; retry the check.`,
      );
    }
  };

  const unsubscribeAuth = client.auth.onChange((session) => {
    connectCheckGeneration += 1;
    if (session) {
      setConnectState('authenticated', session);
    } else {
      setConnectState('signed_out', undefined);
    }
  });
  window.addEventListener('pagehide', () => {
    unsubscribeAuth();
    if (connectExpiryTimer !== undefined) window.clearTimeout(connectExpiryTimer);
    if (gameAuthorizationTimer !== undefined) window.clearTimeout(gameAuthorizationTimer);
  }, { once: true });

  const updateGameAuthorizationButton = () => {
    const authorization = game.getAuthorization();
    connectButton.textContent = authorization ? 'Game authorized' : 'Authorize game';
    connectButton.disabled = busy || Boolean(authorization);
    return authorization;
  };

  const changed = (message) => {
    if (gameAuthorizationTimer !== undefined) {
      window.clearTimeout(gameAuthorizationTimer);
      gameAuthorizationTimer = undefined;
    }
    const authorization = updateGameAuthorizationButton();
    const currentAddress = authorization?.address.toLowerCase();
    if (currentAddress !== gameAuthorizationAddress) void round?.refresh();
    gameAuthorizationAddress = currentAddress;
    if (message) {
      connectionStatus.textContent = message;
    } else if (authorization) {
      connectionStatus.textContent = 'A valid authorization is saved for this Studio app, credit group, and game origin.';
    } else {
      connectionStatus.textContent = 'Studio game authorization is separate from Connect sign-in. Authorize this game to load credits.';
    }
    if (authorization) {
      const expiresAt = Date.parse(authorization.expiresAt);
      if (Number.isFinite(expiresAt) && expiresAt > Date.now()) {
        const delay = Math.min(expiresAt - Date.now(), 2_147_483_647);
        gameAuthorizationTimer = window.setTimeout(() => {
          if (!game.getAuthorization()) {
            changed('The scoped game authorization expired. Authorize this game again to load credits.');
            void credits.refresh();
            return;
          }
          changed();
        }, delay);
      }
    }
  };

  credits = new Credits({
    client,
    game,
    root: document.querySelector('#credits'),
    storageKey: `${baseKey}:purchase`,
    display,
    connectUrl,
    usdcAddress: mainnetUsdc,
    changed,
  });
  round = new PaidRound({
    game,
    root: document.querySelector('#game'),
    storageKey: `${baseKey}:round`,
    getBalance: () => credits.balance,
  });
  credits.render();
  round.render();
  changed();
  if (display === 'embed' && !embeddedConnectAvailable) {
    signInButton.disabled = true;
    connectButton.disabled = true;
    signInStatus.textContent = 'Embedded Connect is unavailable in this SDK bundle; no popup fallback will be used.';
    connectionStatus.textContent = 'Load the verified local embedded SDK bundle before signing in or authorizing this game.';
  } else {
    const restoredSession = client.auth.getSession();
    if (restoredSession) {
      void verifyConnectSession(restoredSession);
    } else {
      setConnectState('signed_out', undefined);
    }
  }

  signInButton.addEventListener('click', async () => {
    if (busy) return;
    const view = deriveConnectSessionView(connectState, connectSession, Date.now());
    if (view.action === 'none') return;
    if (view.action === 'check') {
      await verifyConnectSession();
      return;
    }
    busy = true;
    updateGameAuthorizationButton();
    renderConnectState();
    signInStatus.textContent = display === 'embed'
      ? 'Opening embedded SuperRare Connect sign-in…'
      : 'Opening SuperRare Connect sign-in in a popup…';
    try {
      const result = await client.auth.login();
      hostedSurface.close();
      if (result.status === 'authenticated') {
        setConnectState('authenticated', result.session);
      } else if (result.status === 'expired') {
        setConnectState(
          'signed_out',
          undefined,
          'The Connect sign-in intent expired before completing. Start sign-in again; no game authorization or saved purchase state was changed.',
        );
      } else {
        setConnectState(
          'signed_out',
          undefined,
          'Connect sign-in was cancelled. No game authorization or saved purchase state was changed.',
        );
      }
    } catch (error) {
      const session = client.auth.getSession();
      const failure = `Sign-in did not complete (${describeSdkFailure(error)}).`;
      if (session) {
        void verifyConnectSession(session, `${failure} Checking the stored Connect session.`);
      } else {
        setConnectState('signed_out', undefined, `${failure} Retry sign-in when ready.`);
      }
    } finally {
      busy = false;
      updateGameAuthorizationButton();
      renderConnectState();
    }
  });
  hostedCloseButton.addEventListener('click', () => {
    hostedSurface.close();
    hostedStatus.textContent = 'Embedded flow closed. If checkout may have reached a wallet, continue the same saved purchase to reconcile it before trying again.';
  });
  connectButton.addEventListener('click', async () => {
    if (busy || game.getAuthorization()) return;
    busy = true;
    updateGameAuthorizationButton();
    renderConnectState();
    connectionStatus.textContent = 'Requesting scoped game authorization from Studio…';
    try {
      await game.connect();
    } catch (error) {
      const failure = describeSdkFailure(error);
      const session = client.auth.getSession();
      const isUnauthorized = typeof error === 'object'
        && error !== null
        && 'status' in error
        && error.status === 401;
      const message = failure === 'ConnectSessionRequiredError'
        ? session
          ? 'The SDK reports no usable Connect session. Retry the Connect session check; stored credentials and pending game state were preserved.'
          : 'Connect sign-in is required. Sign in before authorizing this game; pending game state was preserved.'
        : isUnauthorized
          ? session
            ? 'Studio rejected the saved Connect session (HTTP 401). Retry the Connect session check; stored credentials and pending game state were preserved.'
            : 'Studio requires a Connect session (HTTP 401). Sign in before authorizing this game; pending game state was preserved.'
          : failure === 'cancelled'
            ? 'Studio game authorization was cancelled. Retry when ready; no play or payment was started.'
            : `Studio did not issue game authorization (${failure}). Retry explicitly; no play or payment was started.`;
      if (failure === 'ConnectSessionRequiredError' || isUnauthorized) {
        if (session) {
          setConnectState('verification_failed', session, message);
        } else {
          setConnectState('signed_out', undefined, message);
        }
      }
      changed(message);
      busy = false;
      updateGameAuthorizationButton();
      renderConnectState();
      return;
    }

    changed('Studio authorized this game. Loading the credit balance and saved round state…');
    const refreshResults = await Promise.allSettled([credits.refresh(), round.refresh()]);
    const refreshFailure = refreshResults.find((result) => result.status === 'rejected');
    const outcome = deriveGameAuthorizationView(
      game.getAuthorization(),
      refreshFailure?.status === 'rejected',
    );
    connectButton.textContent = outcome.buttonLabel;
    connectionStatus.textContent = outcome.state === 'authorization_confirmed_refresh_failed'
      && refreshFailure?.status === 'rejected'
      ? `${outcome.status} (${describeSdkFailure(refreshFailure.reason)}). Retry the affected panel; no play or payment was started.`
      : outcome.status;
    busy = false;
    updateGameAuthorizationButton();
    renderConnectState();
  });
}
