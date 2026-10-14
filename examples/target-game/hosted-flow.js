export function deriveConnectSessionView(state, session, now = Date.now()) {
  if (state === 'checking') {
    return {
      state: 'checking',
      action: 'none',
      disabled: true,
      buttonLabel: 'Checking Connect sign-in…',
      status: 'Checking the saved SuperRare Connect session…',
    };
  }
  if (state === 'verification_failed') {
    return {
      state: 'verification_failed',
      action: 'check',
      disabled: false,
      buttonLabel: 'Retry Connect session check',
      status: 'The saved Connect session could not be verified. Its stored credentials were preserved.',
    };
  }

  if (state === 'authenticated') {
    const expiresAt = Date.parse(session?.expiresAt ?? '');
    if (Number.isFinite(expiresAt) && expiresAt > now) {
      return {
        state: 'authenticated',
        action: 'none',
        disabled: true,
        buttonLabel: 'Signed in to SuperRare',
        status: 'Signed in to SuperRare. Authorize this Studio game separately to load credits.',
      };
    }
    return {
      state: 'expired',
      action: 'check',
      disabled: false,
      buttonLabel: 'Check Connect sign-in',
      status: 'The Connect access session needs renewal. Check it before starting another sign-in.',
    };
  }

  return {
    state: 'signed_out',
    action: 'login',
    disabled: false,
    buttonLabel: 'Sign in to SuperRare',
    status: 'Sign in to SuperRare, then authorize this game separately to load credits.',
  };
}

const GAME_CONFIGURATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isConfigurationRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isServiceOrigin(value) {
  try {
    const url = new URL(value);
    const isLocalHttp = url.protocol === 'http:'
      && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
    return (url.protocol === 'https:' || isLocalHttp)
      && url.origin === value
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

export function resolveExampleConfiguration(query, rawMetadata, currentOrigin) {
  if (rawMetadata !== undefined && !isConfigurationRecord(rawMetadata)) {
    return { ok: false, reason: 'invalid_metadata' };
  }

  const metadata = isConfigurationRecord(rawMetadata) ? rawMetadata : {};
  for (const key of ['appId', 'groupId', 'studioUrl', 'apiUrl', 'connectUrl', 'appOrigin', 'display']) {
    if (Object.hasOwn(metadata, key) && typeof metadata[key] !== 'string') {
      return { ok: false, reason: 'invalid_metadata' };
    }
  }

  const valueFor = (key, fallback = null) => {
    if (query.has(key)) return query.get(key);
    return Object.hasOwn(metadata, key) ? metadata[key] : fallback;
  };

  const appId = valueFor('appId');
  const groupId = valueFor('groupId');
  if (!appId || !groupId) return { ok: false, reason: 'missing_app_or_group' };
  if (!GAME_CONFIGURATION_UUID.test(appId) || !GAME_CONFIGURATION_UUID.test(groupId)) {
    return { ok: false, reason: 'invalid_app_or_group' };
  }

  const studioUrl = valueFor('studioUrl', 'https://studio.superrare.com');
  const apiUrl = valueFor('apiUrl', 'https://api.superrare.com');
  const connectUrl = valueFor('connectUrl', 'https://connect.superrare.com');
  const appOrigin = valueFor('appOrigin');
  const display = valueFor('display');
  if (![studioUrl, apiUrl, connectUrl].every(isServiceOrigin)) {
    return { ok: false, reason: 'invalid_service_url' };
  }
  if (display !== null && display !== 'embed' && display !== 'popup') {
    return { ok: false, reason: 'invalid_display' };
  }
  if (appOrigin !== null) {
    if (!isServiceOrigin(appOrigin) || !appOrigin.startsWith('https://')) {
      return { ok: false, reason: 'invalid_app_origin' };
    }
    if (appOrigin !== currentOrigin) return { ok: false, reason: 'app_origin_mismatch' };
  }

  return {
    ok: true,
    configuration: { appId, groupId, studioUrl, apiUrl, connectUrl, appOrigin, display },
  };
}

export function resolveHostedDisplay(display, connectUrl) {
  if (display !== null && display !== 'embed' && display !== 'popup') {
    return { ok: false, reason: 'invalid_display' };
  }
  let connectOrigin;
  try {
    connectOrigin = new URL(connectUrl).origin;
  } catch {
    return { ok: false, reason: 'invalid_connect_url' };
  }
  if (display === 'embed' || display === 'popup') return { ok: true, display };
  if (connectOrigin === 'https://connect-dev-mainnet.superrare.co') {
    return { ok: true, display: 'embed' };
  }
  return { ok: false, reason: 'display_required' };
}

export function deriveGameAuthorizationView(authorization, refreshFailed) {
  if (!authorization) {
    return {
      state: 'authorization_not_confirmed',
      buttonLabel: 'Authorize game',
      status: 'Studio returned an authorization result, but it is no longer valid for this game scope. See the credits panel for any rejected request; authorize again only after resolving it.',
    };
  }
  if (refreshFailed) {
    return {
      state: 'authorization_confirmed_refresh_failed',
      buttonLabel: 'Game authorized',
      status: 'Game authorization is confirmed, but refreshing game state failed.',
    };
  }
  return {
    state: 'authorization_confirmed',
    buttonLabel: 'Game authorized',
    status: 'This game is authorized for the configured Studio app, credit group, and origin. Balance and round recovery status are shown in their own panels.',
  };
}

export function describeSdkFailure(error) {
  if (typeof error !== 'object' || error === null) return 'unknown error';

  const details = [];
  if ('code' in error && typeof error.code === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(error.code)) {
    details.push(error.code);
  }
  if ('status' in error && typeof error.status === 'number' && Number.isInteger(error.status)) {
    details.push(`HTTP ${error.status}`);
  }
  if ('path' in error && typeof error.path === 'string' && error.path.startsWith('/')
    && error.path.split('/').every((segment) => /^[A-Za-z0-9._%-]*$/.test(segment))) {
    details.push(error.path);
  }

  if (details.length > 0) return details.join(' · ');
  if (error instanceof Error && error.name === 'TypeError' && error.message === 'Failed to fetch') {
    return 'network request failed';
  }
  return error instanceof Error ? error.name : 'unknown error';
}

export function createHostedConnectSurface({ dialog, frameRoot, status }) {
  let activeWindow;

  const closeDialog = () => {
    if (dialog.open) dialog.close();
  };

  const surface = {
    open(url, target) {
      if (dialog.open || activeWindow && !activeWindow.closed) return null;
      const frame = document.createElement('iframe');
      frame.title = 'SuperRare Connect';
      frame.name = target;
      frame.allow = 'payment';
      frame.loading = 'eager';
      frameRoot.replaceChildren(frame);
      status.textContent = 'Loading hosted Connect…';
      dialog.showModal();
      frame.src = url;

      let closed = false;
      const opened = {
        get closed() { return closed; },
        close() {
          if (closed) return;
          closed = true;
          frame.remove();
          if (activeWindow === opened) activeWindow = undefined;
          closeDialog();
        },
        location: {
          replace(nextUrl) {
            if (!closed) frame.src = nextUrl;
          },
        },
        messageSource: frame.contentWindow,
      };
      activeWindow = opened;
      return opened;
    },

    messageEvents: {
      subscribe(listener) {
        const handleMessage = (event) => listener({
          origin: event.origin,
          data: event.data,
          source: event.source,
        });
        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
      },
    },

    onUnavailable(error) {
      status.textContent = `Embedded Connect is unavailable (${describeSdkFailure(error)}). No automatic popup fallback was opened; retry sign-in or checkout explicitly.`;
      if (!dialog.open) dialog.showModal();
    },

    close() {
      if (activeWindow) activeWindow.close();
      else closeDialog();
    },
  };

  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    surface.close();
    status.textContent = 'Embedded flow closed. Continue the same saved purchase if checkout may have reached a wallet.';
  });

  return surface;
}
