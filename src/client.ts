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
  buildConnectBidIntentRequest,
  buildConnectBuyIntentRequest,
  buildConnectMintIntentRequest,
  type BidActionParams,
  type BuyActionParams,
  type MintActionParams,
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
import type { ConnectCheckoutStatus, ConnectIntent } from './status-core.js';

export type SuperRareConnectClientOptions = ConnectAuthApiOptions & {
  connectUrl?: string;
  initiatingOrigin?: string;
  createState?: () => string;
  navigation?: ConnectNavigation | false;
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
  const startIntent = async (
    requestResult:
      | ReturnType<typeof buildConnectCheckoutIntentRequest>
      | ReturnType<typeof buildConnectBuyIntentRequest>
      | ReturnType<typeof buildConnectBidIntentRequest>
      | ReturnType<typeof buildConnectMintIntentRequest>,
  ): Promise<ConnectIntentCreation> => {
    if (!requestResult.ok) {
      throw new ConnectReturnPathError();
    }

    const intent = resolveHostedIntent(await createConnectIntent({
      ...apiOptions,
      request: requestResult.request,
    }));
    navigation?.assign(intent.url);
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
