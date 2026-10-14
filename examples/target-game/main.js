import { Credits } from './credits.js';
import {
  createHostedConnectSurface,
  describeSdkFailure,
  deriveConnectSessionView,
  deriveGameAuthorizationView,
  resolveExampleConfiguration,
  resolveHostedDisplay,
} from './hosted-flow.js';
import { PaidRound } from './round.js';
const params = new URLSearchParams(location.search);
let hostedMetadata;
let hostedConfigError;
const isLoopbackOrigin = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const hasCompleteQueryConfiguration = ['appId', 'groupId', 'studioUrl', 'apiUrl', 'connectUrl', 'display']
  .every((key) => params.has(key));
if (!isLoopbackOrigin || !hasCompleteQueryConfiguration) {
  try {
    const response = await fetch('/config.json', { cache: 'no-store' });
    if (!response.ok) hostedConfigError = `HTTP ${response.status}`;
    else hostedMetadata = await response.json();
  } catch (error) {
    hostedConfigError = describeSdkFailure(error);
  }
}
const configurationResult = resolveExampleConfiguration(params, hostedMetadata, location.origin);
const configuration = configurationResult.ok ? configurationResult.configuration : undefined;
const appId = configuration?.appId;
const groupId = configuration?.groupId;
const studioUrl = configuration?.studioUrl;
const apiUrl = configuration?.apiUrl;
const connectUrl = configuration?.connectUrl;
const displayConfiguration = configuration
  ? resolveHostedDisplay(configuration.display, connectUrl)
  : undefined;
const display = displayConfiguration?.ok ? displayConfiguration.display : undefined;
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

if (!configuration) {
  const messages = {
    missing_app_or_group: 'Supply your Studio appId and credit groupId in the URL or publish a root /config.json.',
    invalid_app_or_group: 'The configured Studio appId and credit groupId must be valid UUIDs.',
    invalid_service_url: 'The Studio, Rare API, and Connect service settings must be valid HTTPS origins (or localhost HTTP origins for local development).',
    invalid_app_origin: 'The configured game origin must be an HTTPS origin.',
    app_origin_mismatch: 'This game is not running at its configured approved app origin.',
    invalid_metadata: 'The root /config.json must contain string values for its app, group, service, origin, and display settings.',
    invalid_display: 'Set display=embed or display=popup in the URL or root /config.json.',
  };
  signInButton.disabled = true;
  connectButton.disabled = true;
  signInStatus.textContent = 'Game configuration is required before signing in or authorizing.';
  connectionStatus.textContent = `${messages[configurationResult.reason] ?? 'Game configuration could not be resolved.'}${hostedConfigError ? ` (/config.json: ${hostedConfigError})` : ''}`;
} else if (!displayConfiguration.ok) {
  const messages = {
    invalid_connect_url: 'Set a valid Connect base URL before choosing a hosted-flow display.',
    invalid_display: 'Set display=embed or display=popup.',
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
  // Hosted game/scoring paths pass through the platform on the app origin.
  // Its one-time run sockets deliberately reject cross-origin connections.
  const scoringGame = window.SuperRareConnect.createSuperRareClient({
    studioUrl: location.origin,
    apiUrl,
    connectUrl,
    storage: false,
    navigation: false,
  }).games.forGame({ appId });
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
    connectButton.hidden = connectState === 'signed_out' || connectState === 'checking'
      || Boolean(game.getAuthorization());
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
      if (!busy) await authorizeGame();
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
      if (!busy) void authorizeGame();
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
    connectButton.textContent = authorization ? 'Game authorized' : 'Retry game authorization';
    connectButton.hidden = Boolean(authorization) || connectState === 'signed_out' || connectState === 'checking';
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
      connectionStatus.textContent = 'Sign in to SuperRare to connect this game and load credits.';
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
    scoringGame,
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
        await authorizeGame();
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
  const authorizeGame = async () => {
    const previousBusy = busy;
    busy = true;
    updateGameAuthorizationButton();
    renderConnectState();
    connectionStatus.textContent = 'Connecting this game and loading your credits…';
    try {
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
            : 'Connect sign-in is required. Sign in to connect this game; pending game state was preserved.'
          : isUnauthorized
            ? session
              ? 'Studio rejected the saved Connect session (HTTP 401). Retry the Connect session check; stored credentials and pending game state were preserved.'
              : 'Studio requires a Connect session (HTTP 401). Sign in to connect this game; pending game state was preserved.'
            : failure === 'cancelled'
              ? 'Game connection was cancelled. Retry when ready; no play or payment was started.'
              : `Game connection did not complete (${failure}). Retry the game connection; no play or payment was started.`;
        if (failure === 'ConnectSessionRequiredError' || isUnauthorized) {
          setConnectState(session ? 'verification_failed' : 'signed_out', session, message);
        }
        changed(message);
        return;
      }
      const creditResults = await Promise.allSettled([credits.refresh()]);
      changed('Game connected. Loading your saved round…');
      const roundResults = await Promise.allSettled([round.refresh()]);
      const refreshFailure = [...creditResults, ...roundResults].find((result) => result.status === 'rejected');
      const outcome = deriveGameAuthorizationView(
        game.getAuthorization(),
        refreshFailure?.status === 'rejected',
      );
      connectionStatus.textContent = outcome.state === 'authorization_confirmed_refresh_failed'
        && refreshFailure?.status === 'rejected'
        ? `${outcome.status} (${describeSdkFailure(refreshFailure.reason)}). Retry the affected panel; no play or payment was started.`
        : outcome.status;
    } finally {
      busy = previousBusy;
      updateGameAuthorizationButton();
      renderConnectState();
    }
  };
  connectButton.addEventListener('click', async () => {
    if (busy || game.getAuthorization()) return;
    await authorizeGame();
  });
}
