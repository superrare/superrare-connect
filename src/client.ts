import {
  createConnectIntent,
  createConnectLoginIntent,
  exchangeConnectAuthCode,
  getConnectCheckoutStatus,
  getConnectCurrentUser,
  getConnectIntent,
  getConnectSession,
  type ConnectAuthApiOptions,
  type ConnectCurrentUser,
  type ConnectIntentCreation,
  type ConnectSessionState,
} from './api.js';
import {
  buildConnectAcceptOfferIntentRequest,
  buildConnectBidIntentRequest,
  buildConnectBuyIntentRequest,
  buildConnectCancelOfferIntentRequest,
  buildConnectMakeOfferIntentRequest,
  buildConnectMintIntentRequest,
  buildConnectSettleIntentRequest,
  type AcceptOfferActionParams,
  type BidActionParams,
  type BuyActionParams,
  type CancelOfferActionParams,
  type MakeOfferActionParams,
  type MintActionParams,
  type SettleActionParams,
} from './actions-flow-core.js';
import {
  buildConnectLoginIntentRequest,
  parseStoredPendingConnectAuth,
  serializePendingConnectAuth,
  verifyConnectAuthCallbackAgainstPending,
  type ConnectAuthPendingVerificationError,
  type PendingConnectAuth,
} from './auth-flow-core.js';
import {
  parseConnectAuthCallbackSearchParams,
  type ConnectAuthCallbackParams,
  type ConnectAuthCallbackParseResult,
} from './callback-core.js';
import {
  buildConnectCheckoutIntentRequest,
  type CheckoutStartParams,
} from './checkout-flow-core.js';
import {
  readConnectSessionFromStorage,
  removeConnectSessionFromStorage,
  writeConnectSessionToStorage,
  type ConnectSession,
  type ConnectSessionStorage,
} from './session-storage-core.js';
import {
  appendConnectPopupDisplay,
  getConnectPopupFeatures,
  isConnectIntentSettled,
  type ConnectPopupOpener,
  type ConnectPopupSize,
  type ConnectPopupWindow,
} from './popup-core.js';
import type { ConnectCheckoutStatus, ConnectIntent } from './status-core.js';

export type SuperRareConnectClientOptions = ConnectAuthApiOptions & {
  connectUrl?: string;
  initiatingOrigin?: string;
  createState?: () => string;
  navigation?: ConnectNavigation | false;
  /**
   * How hosted action/checkout intents open. `redirect` (default) navigates
   * the current page; `popup` opens a small centered window — the integrator's
   * page stays put and `onIntentSettled` fires when the flow finishes.
   * Login intents always redirect (the auth callback returns to the page).
   */
  display?: 'redirect' | 'popup';
  popup?: ConnectPopupSize & { open?: ConnectPopupOpener };
  /**
   * Popup mode only: called once the intent reaches a terminal status, or with
   * the latest intent state when the user closes the popup early.
   */
  onIntentSettled?: (intent: ConnectIntent) => void;
  sessionStorage?: ConnectSessionStorage | false;
  pendingAuthStorageKey?: string;
  sessionStorageKey?: string;
};

export type ConnectNavigation = {
  assign: (url: string) => void;
};

export type ConnectAuthLoginParams = {
  returnPath?: string;
  initiatingOrigin?: string;
};

export type SuperRareConnectAuthNamespace = {
  login: (params?: ConnectAuthLoginParams) => Promise<ConnectIntentCreation>;
  parseCallback: (searchParams: URLSearchParams) => ConnectAuthCallbackParseResult;
  exchangeCallback: (searchParams: URLSearchParams) => Promise<ConnectSession>;
  exchangeCode: (params: ConnectAuthCallbackParams) => Promise<ConnectSession>;
  getSession: () => ConnectSession | undefined;
  getRemoteSession: () => Promise<ConnectSessionState>;
  me: () => Promise<ConnectCurrentUser>;
  logout: () => void;
  onChange: (callback: ConnectSessionChangeCallback) => () => void;
  clearSession: () => void;
};

export type ConnectSessionChangeCallback = (session: ConnectSession | undefined) => void;

export type SuperRareConnectUserNamespace = {
  me: () => Promise<ConnectCurrentUser>;
};

export type SuperRareConnectCheckoutNamespace = {
  start: (params: CheckoutStartParams) => Promise<ConnectIntentCreation>;
  getStatus: (params: { sessionId: string }) => Promise<ConnectCheckoutStatus>;
};

export type SuperRareConnectActionsNamespace = {
  buy: (params: BuyActionParams) => Promise<ConnectIntentCreation>;
  bid: (params: BidActionParams) => Promise<ConnectIntentCreation>;
  mint: (params: MintActionParams) => Promise<ConnectIntentCreation>;
  settle: (params: SettleActionParams) => Promise<ConnectIntentCreation>;
  getStatus: (params: { intentId: string }) => Promise<ConnectIntent>;
};

export type SuperRareConnectOffersNamespace = {
  make: (params: MakeOfferActionParams) => Promise<ConnectIntentCreation>;
  accept: (params: AcceptOfferActionParams) => Promise<ConnectIntentCreation>;
  cancel: (params: CancelOfferActionParams) => Promise<ConnectIntentCreation>;
  getStatus: (params: { intentId: string }) => Promise<ConnectIntent>;
};

export type SuperRareConnectIntentsNamespace = {
  get: (params: { intentId: string }) => Promise<ConnectIntent>;
};

export type SuperRareConnectClient = {
  auth: SuperRareConnectAuthNamespace;
  user: SuperRareConnectUserNamespace;
  checkout: SuperRareConnectCheckoutNamespace;
  actions: SuperRareConnectActionsNamespace;
  offers: SuperRareConnectOffersNamespace;
  intents: SuperRareConnectIntentsNamespace;
};

export class ConnectAuthCallbackError extends Error {
  readonly code: Exclude<ConnectAuthCallbackParseResult, { ok: true }>['error'];

  constructor(code: Exclude<ConnectAuthCallbackParseResult, { ok: true }>['error']) {
    super(`Invalid Connect auth callback: ${code}`);
    this.name = 'ConnectAuthCallbackError';
    this.code = code;
  }
}

export class ConnectAuthPendingError extends Error {
  readonly code: ConnectAuthPendingVerificationError;

  constructor(code: ConnectAuthPendingVerificationError) {
    super(`Invalid Connect auth pending state: ${code}`);
    this.name = 'ConnectAuthPendingError';
    this.code = code;
  }
}

export class ConnectReturnPathError extends Error {
  readonly code = 'invalid_return_path';

  constructor() {
    super('Invalid Connect returnPath.');
    this.name = 'ConnectReturnPathError';
  }
}

export class ConnectSessionRequiredError extends Error {
  constructor() {
    super('A Connect session is required.');
    this.name = 'ConnectSessionRequiredError';
  }
}

const DEFAULT_CONNECT_SESSION_STORAGE_KEY = 'superrare.connect.session';
const DEFAULT_CONNECT_PENDING_AUTH_STORAGE_KEY = 'superrare.connect.pendingAuth';

export function createSuperRareClient(
  options: SuperRareConnectClientOptions = {},
): SuperRareConnectClient {
  const storage = resolveConnectSessionStorage(options.sessionStorage);
  const storageKey = options.sessionStorageKey ?? DEFAULT_CONNECT_SESSION_STORAGE_KEY;
  const pendingAuthStorageKey = options.pendingAuthStorageKey ?? DEFAULT_CONNECT_PENDING_AUTH_STORAGE_KEY;
  const navigation = resolveConnectNavigation(options.navigation);
  const sessionListeners = new Set<ConnectSessionChangeCallback>();
  const apiOptions = {
    apiUrl: options.apiUrl,
    fetch: options.fetch,
  };
  const resolveHostedIntent = (intent: ConnectIntentCreation): ConnectIntentCreation => ({
    ...intent,
    url: resolveHostedConnectUrl({
      connectUrl: options.connectUrl,
      url: intent.url,
    }),
  });
  const createState = options.createState ?? createConnectState;
  const exchangeCode = async (params: ConnectAuthCallbackParams): Promise<ConnectSession> => {
    const session = await exchangeConnectAuthCode(params, apiOptions);
    writeConnectSessionToStorage(storage, storageKey, session);
    removePendingAuthFromStorage(storage, pendingAuthStorageKey);
    notifySessionListeners(sessionListeners, session);
    return session;
  };
  const openPopupWindow = (): ConnectPopupWindow | null => {
    const open = options.popup?.open ?? readBrowserPopupOpener();
    if (open === undefined) return null;

    const screen = readBrowserScreenSize();
    return open(
      'about:blank',
      'superrare-connect',
      getConnectPopupFeatures({
        size: options.popup,
        screenWidth: screen?.width,
        screenHeight: screen?.height,
      }),
    );
  };
  const watchPopupIntent = async (
    popup: ConnectPopupWindow,
    intentId: string,
  ): Promise<void> => {
    for (;;) {
      await sleep(POPUP_POLL_INTERVAL_MS);
      let intent: ConnectIntent | undefined;
      try {
        intent = await getConnectIntent({ ...apiOptions, intentId });
      } catch {
        // Transient fetch failure — keep watching while the popup is open.
      }

      if (intent !== undefined && isConnectIntentSettled(intent.status)) {
        if (!popup.closed) popup.close();
        options.onIntentSettled?.(intent);
        return;
      }

      if (popup.closed) {
        // The user dismissed the popup; report the latest known state.
        if (intent === undefined) {
          try {
            intent = await getConnectIntent({ ...apiOptions, intentId });
          } catch {
            return;
          }
        }
        options.onIntentSettled?.(intent);
        return;
      }
    }
  };
  const startIntent = async (
    requestResult:
      | ReturnType<typeof buildConnectCheckoutIntentRequest>
      | ReturnType<typeof buildConnectBuyIntentRequest>
      | ReturnType<typeof buildConnectBidIntentRequest>
      | ReturnType<typeof buildConnectMintIntentRequest>
      | ReturnType<typeof buildConnectMakeOfferIntentRequest>
      | ReturnType<typeof buildConnectAcceptOfferIntentRequest>
      | ReturnType<typeof buildConnectCancelOfferIntentRequest>,
  ): Promise<ConnectIntentCreation> => {
    if (!requestResult.ok) {
      throw new ConnectReturnPathError();
    }

    // The popup must open before the first await to stay inside the user
    // gesture; otherwise browsers block it. It navigates once the intent exists.
    const popup = options.display === 'popup' ? openPopupWindow() : null;
    let intent: ConnectIntentCreation;
    try {
      intent = resolveHostedIntent(await createConnectIntent({
        ...apiOptions,
        request: requestResult.request,
      }));
    } catch (error) {
      popup?.close();
      throw error;
    }

    if (popup !== null) {
      popup.location.replace(appendConnectPopupDisplay(intent.url));
      void watchPopupIntent(popup, intent.intentId);
    } else {
      navigation?.assign(intent.url);
    }

    return intent;
  };
  const me = async (): Promise<ConnectCurrentUser> => {
    const session = readConnectSessionFromStorage(storage, storageKey);
    if (session === undefined) {
      throw new ConnectSessionRequiredError();
    }

    return await getConnectCurrentUser({
      ...apiOptions,
      sessionId: session.sessionId,
    });
  };

  return {
    auth: {
      async login(params = {}): Promise<ConnectIntentCreation> {
        const requestResult = buildConnectLoginIntentRequest({
          returnPath: params.returnPath,
          state: createState(),
          initiatingOrigin: params.initiatingOrigin ?? options.initiatingOrigin ?? readBrowserOrigin(),
        });
        if (!requestResult.ok) {
          throw new ConnectReturnPathError();
        }

        const intent = resolveHostedIntent(await createConnectLoginIntent({
          ...apiOptions,
          request: requestResult.request,
        }));
        writePendingAuthToStorage(storage, pendingAuthStorageKey, {
          intentId: intent.intentId,
          state: requestResult.request.state,
          expiresAt: intent.expiresAt,
        });
        navigation?.assign(intent.url);
        return intent;
      },
      parseCallback: parseConnectAuthCallbackSearchParams,
      async exchangeCallback(searchParams): Promise<ConnectSession> {
        const parseResult = parseConnectAuthCallbackSearchParams(searchParams);
        if (!parseResult.ok) {
          throw new ConnectAuthCallbackError(parseResult.error);
        }

        const pendingVerificationResult = verifyConnectAuthCallbackAgainstPending({
          pendingAuth: readPendingAuthFromStorage(storage, pendingAuthStorageKey),
          callbackParams: parseResult.params,
        });
        if (!pendingVerificationResult.ok) {
          throw new ConnectAuthPendingError(pendingVerificationResult.error);
        }

        return exchangeCode(parseResult.params);
      },
      exchangeCode,
      getSession(): ConnectSession | undefined {
        return readConnectSessionFromStorage(storage, storageKey);
      },
      async getRemoteSession(): Promise<ConnectSessionState> {
        const session = readConnectSessionFromStorage(storage, storageKey);
        return await getConnectSession({
          ...apiOptions,
          sessionId: session?.sessionId,
        });
      },
      async me(): Promise<ConnectCurrentUser> {
        return await me();
      },
      clearSession(): void {
        removeConnectSessionFromStorage(storage, storageKey);
        removePendingAuthFromStorage(storage, pendingAuthStorageKey);
        notifySessionListeners(sessionListeners, undefined);
      },
      logout(): void {
        this.clearSession();
      },
      onChange(callback): () => void {
        sessionListeners.add(callback);
        return () => {
          sessionListeners.delete(callback);
        };
      },
    },
    user: {
      me,
    },
    checkout: {
      async start(params): Promise<ConnectIntentCreation> {
        return await startIntent(buildConnectCheckoutIntentRequest({
          ...params,
          state: createState(),
          initiatingOrigin: params.initiatingOrigin ?? options.initiatingOrigin ?? readBrowserOrigin(),
        }));
      },
      async getStatus(params): Promise<ConnectCheckoutStatus> {
        return await getConnectCheckoutStatus({
          ...apiOptions,
          sessionId: params.sessionId,
        });
      },
    },
    actions: {
      async buy(params): Promise<ConnectIntentCreation> {
        return await startIntent(buildConnectBuyIntentRequest({
          ...params,
          state: createState(),
          initiatingOrigin: params.initiatingOrigin ?? options.initiatingOrigin ?? readBrowserOrigin(),
        }));
      },
      async bid(params): Promise<ConnectIntentCreation> {
        return await startIntent(buildConnectBidIntentRequest({
          ...params,
          state: createState(),
          initiatingOrigin: params.initiatingOrigin ?? options.initiatingOrigin ?? readBrowserOrigin(),
        }));
      },
      async settle(params): Promise<ConnectIntentCreation> {
        return await startIntent(buildConnectSettleIntentRequest({
          ...params,
          state: createState(),
          initiatingOrigin: params.initiatingOrigin ?? options.initiatingOrigin ?? readBrowserOrigin(),
        }));
      },
      async mint(params): Promise<ConnectIntentCreation> {
        return await startIntent(buildConnectMintIntentRequest({
          ...params,
          state: createState(),
          initiatingOrigin: params.initiatingOrigin ?? options.initiatingOrigin ?? readBrowserOrigin(),
        }));
      },
      async getStatus(params): Promise<ConnectIntent> {
        return await getConnectIntent({
          ...apiOptions,
          intentId: params.intentId,
        });
      },
    },
    offers: {
      async make(params): Promise<ConnectIntentCreation> {
        return await startIntent(buildConnectMakeOfferIntentRequest({
          ...params,
          state: createState(),
          initiatingOrigin: params.initiatingOrigin ?? options.initiatingOrigin ?? readBrowserOrigin(),
        }));
      },
      async accept(params): Promise<ConnectIntentCreation> {
        return await startIntent(buildConnectAcceptOfferIntentRequest({
          ...params,
          state: createState(),
          initiatingOrigin: params.initiatingOrigin ?? options.initiatingOrigin ?? readBrowserOrigin(),
        }));
      },
      async cancel(params): Promise<ConnectIntentCreation> {
        return await startIntent(buildConnectCancelOfferIntentRequest({
          ...params,
          state: createState(),
          initiatingOrigin: params.initiatingOrigin ?? options.initiatingOrigin ?? readBrowserOrigin(),
        }));
      },
      async getStatus(params): Promise<ConnectIntent> {
        return await getConnectIntent({
          ...apiOptions,
          intentId: params.intentId,
        });
      },
    },
    intents: {
      async get(params): Promise<ConnectIntent> {
        return await getConnectIntent({
          ...apiOptions,
          intentId: params.intentId,
        });
      },
    },
  };
}

function notifySessionListeners(
  listeners: Set<ConnectSessionChangeCallback>,
  session: ConnectSession | undefined,
): void {
  listeners.forEach((listener) => {
    listener(session);
  });
}

function resolveConnectSessionStorage(
  storage: ConnectSessionStorage | false | undefined,
): ConnectSessionStorage | undefined {
  if (storage === false) return undefined;
  return storage ?? readBrowserLocalStorage();
}

function readBrowserLocalStorage(): ConnectSessionStorage | undefined {
  const storage = Reflect.get(globalThis, 'localStorage');
  return isConnectSessionStorage(storage) ? storage : undefined;
}

function resolveConnectNavigation(
  navigation: ConnectNavigation | false | undefined,
): ConnectNavigation | undefined {
  if (navigation === false) return undefined;
  return navigation ?? readBrowserNavigation();
}

function readBrowserNavigation(): ConnectNavigation | undefined {
  const location = Reflect.get(globalThis, 'location');
  return isConnectNavigation(location) ? location : undefined;
}

const POPUP_POLL_INTERVAL_MS = 2000;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readBrowserPopupOpener(): ConnectPopupOpener | undefined {
  const open = Reflect.get(globalThis, 'open');
  if (typeof open !== 'function') return undefined;
  return (url, target, features) => {
    const popup: unknown = open.call(globalThis, url, target, features);
    return isConnectPopupWindow(popup) ? popup : null;
  };
}

function isConnectPopupWindow(value: unknown): value is ConnectPopupWindow {
  return (
    typeof value === 'object' &&
    value !== null &&
    'closed' in value &&
    'close' in value &&
    'location' in value &&
    typeof value.close === 'function'
  );
}

function readBrowserScreenSize(): { width: number; height: number } | undefined {
  const screen: unknown = Reflect.get(globalThis, 'screen');
  if (
    typeof screen === 'object' &&
    screen !== null &&
    'width' in screen &&
    'height' in screen &&
    typeof screen.width === 'number' &&
    typeof screen.height === 'number'
  ) {
    return { width: screen.width, height: screen.height };
  }

  return undefined;
}

function isConnectNavigation(value: unknown): value is ConnectNavigation {
  return (
    typeof value === 'object' &&
    value !== null &&
    'assign' in value &&
    typeof value.assign === 'function'
  );
}

function isConnectSessionStorage(value: unknown): value is ConnectSessionStorage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'getItem' in value &&
    'setItem' in value &&
    'removeItem' in value &&
    typeof value.getItem === 'function' &&
    typeof value.setItem === 'function' &&
    typeof value.removeItem === 'function'
  );
}

function createConnectState(): string {
  const crypto = globalThis.crypto;
  if (crypto === undefined) {
    throw new Error('Secure browser crypto is required to create a Connect auth state.');
  }

  return crypto.randomUUID();
}

function readBrowserOrigin(): string | undefined {
  const location = Reflect.get(globalThis, 'location');
  return isLocationWithOrigin(location) ? location.origin : undefined;
}

function isLocationWithOrigin(value: unknown): value is { origin: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'origin' in value &&
    typeof value.origin === 'string' &&
    value.origin.length > 0
  );
}

function resolveHostedConnectUrl(input: {
  connectUrl: string | undefined;
  url: string;
}): string {
  if (input.connectUrl === undefined || input.connectUrl.trim().length === 0) {
    return input.url;
  }

  const hostedUrl = new URL(input.url);
  const connectUrl = new URL(input.connectUrl);
  hostedUrl.protocol = connectUrl.protocol;
  hostedUrl.hostname = connectUrl.hostname;
  hostedUrl.port = connectUrl.port;
  hostedUrl.username = connectUrl.username;
  hostedUrl.password = connectUrl.password;
  return hostedUrl.toString();
}

function readPendingAuthFromStorage(
  storage: ConnectSessionStorage | undefined,
  storageKey: string,
): PendingConnectAuth | undefined {
  const serializedPendingAuth = storage?.getItem(storageKey);
  return serializedPendingAuth === null || serializedPendingAuth === undefined
    ? undefined
    : parseStoredPendingConnectAuth(serializedPendingAuth);
}

function writePendingAuthToStorage(
  storage: ConnectSessionStorage | undefined,
  storageKey: string,
  pendingAuth: PendingConnectAuth,
): void {
  storage?.setItem(storageKey, serializePendingConnectAuth(pendingAuth));
}

function removePendingAuthFromStorage(
  storage: ConnectSessionStorage | undefined,
  storageKey: string,
): void {
  storage?.removeItem(storageKey);
}
