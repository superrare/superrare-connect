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
import {
  getConnectPopupLoginDeadline,
  parseConnectAuthCallbackMessage,
  type ConnectPopupLoginResult,
} from './popup-login-core.js';
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
   * `auth.login` always redirects (the auth callback returns to the page);
   * `auth.loginWithPopup` is the popup counterpart for login.
   */
  display?: 'redirect' | 'popup';
  popup?: ConnectPopupSize & {
    open?: ConnectPopupOpener;
    /** Message-event source for popup login; defaults to the window. */
    messageEvents?: ConnectPopupMessageEvents;
  };
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

export type ConnectPopupMessageEvent = {
  origin: string;
  data: unknown;
};

export type ConnectPopupMessageEvents = {
  /** Subscribes to `message` events; returns the unsubscribe function. */
  subscribe: (listener: (event: ConnectPopupMessageEvent) => void) => () => void;
};

export type ConnectAuthLoginParams = {
  returnPath?: string;
  initiatingOrigin?: string;
};

export type SuperRareConnectAuthNamespace = {
  login: (params?: ConnectAuthLoginParams) => Promise<ConnectIntentCreation>;
  loginWithPopup: (params?: ConnectAuthLoginParams) => Promise<ConnectPopupLoginResult>;
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
  // Bumped by every session commit or clear: an exchange that resolves after
  // the session changed underneath it (logout, a newer login) must not write
  // its stale result back.
  let sessionGeneration = 0;
  const commitSession = (session: ConnectSession): void => {
    sessionGeneration += 1;
    writeConnectSessionToStorage(storage, storageKey, session);
    removePendingAuthFromStorage(storage, pendingAuthStorageKey);
    notifySessionListeners(sessionListeners, session);
  };
  const exchangeCode = async (params: ConnectAuthCallbackParams): Promise<ConnectSession> => {
    const session = await exchangeConnectAuthCode(params, apiOptions);
    commitSession(session);
    return session;
  };
  const openPopupWindow = (
    target = 'superrare-connect',
  ): ConnectPopupWindow | null => {
    const open = options.popup?.open ?? readBrowserPopupOpener();
    if (open === undefined) return null;

    const screen = readBrowserScreenSize();
    return open(
      'about:blank',
      target,
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
  const messageEvents = options.popup?.messageEvents ?? readBrowserMessageEvents();
  // Each popup login gets its own named browsing context: a shared name would
  // let a second flow navigate the window out from under the first.
  let popupLoginCount = 0;
  const startLoginIntent = async (
    params: ConnectAuthLoginParams,
  ): Promise<StartedLoginIntent> => {
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
    const pendingAuth: PendingConnectAuth = {
      intentId: intent.intentId,
      state: requestResult.request.state,
      expiresAt: intent.expiresAt,
    };
    writePendingAuthToStorage(storage, pendingAuthStorageKey, pendingAuth);
    return { intent, pendingAuth };
  };
  // Only the record this operation wrote: a newer login may have replaced it.
  const removePendingAuthIfOwned = (intentId: string): void => {
    const storedPendingAuth = readPendingAuthFromStorage(storage, pendingAuthStorageKey);
    if (storedPendingAuth?.intentId === intentId) {
      removePendingAuthFromStorage(storage, pendingAuthStorageKey);
    }
  };
  const completePopupLogin = async (input: {
    params: ConnectAuthCallbackParams;
    intentId: string;
    operationGeneration: number;
  }): Promise<ConnectPopupLoginResult> => {
    const session = await exchangeConnectAuthCode(input.params, apiOptions);
    if (input.operationGeneration !== sessionGeneration) {
      // Logout or another login landed since this operation began; the stale
      // session is dropped rather than written over the current state.
      return { status: 'cancelled' };
    }

    // Commit without the redirect path's unconditional pending cleanup: only
    // this operation's own record may be removed, so a newer redirect login's
    // pending callback survives.
    sessionGeneration += 1;
    const committedGeneration = sessionGeneration;
    writeConnectSessionToStorage(storage, storageKey, session);
    removePendingAuthIfOwned(input.intentId);
    notifySessionListeners(sessionListeners, session);
    // The session is already established; a failed profile lookup must not
    // turn the login into an error.
    const user = await getConnectCurrentUser({
      ...apiOptions,
      sessionId: session.sessionId,
    }).catch((): undefined => undefined);
    if (sessionGeneration !== committedGeneration) {
      // Logged out (or replaced) while the profile was loading — the caller
      // must not be handed this as an active login.
      return { status: 'cancelled' };
    }

    return { status: 'authenticated', session, user };
  };
  const watchPopupLogin = (input: {
    popup: ConnectPopupWindow;
    pendingAuth: PendingConnectAuth;
    messageEvents: ConnectPopupMessageEvents;
    connectOrigin: string;
    deadline: number;
    operationGeneration: number;
  }): Promise<ConnectPopupLoginResult> =>
    new Promise<ConnectPopupLoginResult>((resolve, reject) => {
      let settled = false;
      // The hosted page closes itself right after posting the callback, so
      // the close-watcher must stand down once an exchange is in flight.
      let exchanging = false;
      let unsubscribe: () => void = () => {};
      const settle = (finish: () => void): void => {
        if (settled) return;
        settled = true;
        unsubscribe();
        if (!input.popup.closed) input.popup.close();
        finish();
      };
      // Every outcome except a committed login releases this operation's
      // pending record; the redirect fallback never reaches here.
      const settleWithoutLogin = (finish: () => void): void => {
        settle(() => {
          removePendingAuthIfOwned(input.pendingAuth.intentId);
          finish();
        });
      };

      unsubscribe = input.messageEvents.subscribe((event) => {
        if (settled || exchanging) return;
        const parsed = parseConnectAuthCallbackMessage({
          data: event.data,
          origin: event.origin,
          expectedOrigin: input.connectOrigin,
        });
        // Unrelated or foreign-origin messages — keep waiting. So is a
        // callback for another intent: with overlapping logins it belongs to
        // a sibling operation, not to this one.
        if (!parsed.ok || parsed.params.intentId !== input.pendingAuth.intentId) return;

        // Verified against this operation's own record, so storage-disabled
        // clients and overlapping logins cannot confuse it.
        const verification = verifyConnectAuthCallbackAgainstPending({
          pendingAuth: input.pendingAuth,
          callbackParams: parsed.params,
        });
        if (!verification.ok) {
          settleWithoutLogin(() => {
            reject(new ConnectAuthPendingError(verification.error));
          });
          return;
        }

        if (Date.now() >= input.deadline) {
          settleWithoutLogin(() => {
            resolve({ status: 'expired' });
          });
          return;
        }

        exchanging = true;
        completePopupLogin({
          params: parsed.params,
          intentId: input.pendingAuth.intentId,
          operationGeneration: input.operationGeneration,
        }).then(
          (result) => {
            if (result.status === 'authenticated') {
              settle(() => {
                resolve(result);
              });
              return;
            }

            settleWithoutLogin(() => {
              resolve(result);
            });
          },
          (error: unknown) => {
            settleWithoutLogin(() => {
              reject(toRejectionError(error));
            });
          },
        );
      });

      const watchPopupClosed = async (): Promise<void> => {
        while (!settled) {
          await sleep(POPUP_POLL_INTERVAL_MS);
          if (settled || exchanging) continue;
          if (input.popup.closed) {
            settleWithoutLogin(() => {
              resolve({ status: 'cancelled' });
            });
            return;
          }
          if (Date.now() >= input.deadline) {
            settleWithoutLogin(() => {
              resolve({ status: 'expired' });
            });
            return;
          }
        }
      };
      void watchPopupClosed();
    });

  return {
    auth: {
      async login(params = {}): Promise<ConnectIntentCreation> {
        const { intent } = await startLoginIntent(params);
        navigation?.assign(intent.url);
        return intent;
      },
      async loginWithPopup(params = {}): Promise<ConnectPopupLoginResult> {
        // A logout or another login after this point invalidates the whole
        // operation, so its exchange can never resurrect a replaced session.
        const operationGeneration = sessionGeneration;
        // The popup must open before the first await to stay inside the user
        // gesture; it navigates once the intent exists. Without a message
        // source the callback could never be received, so don't open one.
        popupLoginCount += 1;
        const popup = messageEvents === undefined
          ? null
          : openPopupWindow(`superrare-connect-login-${popupLoginCount}`);
        if (popup === null && storage === undefined) {
          // The redirect fallback verifies its callback against the STORED
          // pending record, so without storage it could never complete.
          throw new Error(
            'The Connect popup could not be opened, and the redirect login fallback requires session storage.',
          );
        }

        let started: StartedLoginIntent;
        try {
          started = await startLoginIntent(params);
        } catch (error) {
          popup?.close();
          throw error;
        }

        const { intent, pendingAuth } = started;
        if (popup === null || messageEvents === undefined) {
          // Popup blocked: fall back to the redirect login — the pending auth
          // is stored, so the normal callback exchange completes it.
          navigation?.assign(intent.url);
          return { status: 'redirected', intent };
        }

        // Nothing may fail between here and the watcher without releasing
        // the blank popup and this operation's pending record.
        let connectOrigin: string;
        let popupUrl: string;
        try {
          connectOrigin = new URL(intent.url).origin;
          popupUrl = appendConnectPopupDisplay(intent.url);
        } catch (error) {
          popup.close();
          removePendingAuthIfOwned(intent.intentId);
          throw new Error('Invalid Connect intent URL.', { cause: error });
        }

        const deadline = getConnectPopupLoginDeadline({
          expiresAt: intent.expiresAt,
          now: Date.now(),
          fallbackMs: POPUP_LOGIN_FALLBACK_TIMEOUT_MS,
        });
        try {
          popup.location.replace(popupUrl);
          return await watchPopupLogin({
            popup,
            pendingAuth,
            messageEvents,
            connectOrigin,
            deadline,
            operationGeneration,
          });
        } catch (error) {
          // The watcher releases its own settlements; this boundary covers a
          // throwing collaborator (navigation, subscription) before the
          // watcher owns the cleanup. Both cleanups are idempotent.
          if (!popup.closed) popup.close();
          removePendingAuthIfOwned(intent.intentId);
          throw error;
        }
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
        sessionGeneration += 1;
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
/** Deadline for a popup login whose intent carries an unparseable expiry. */
const POPUP_LOGIN_FALLBACK_TIMEOUT_MS = 15 * 60_000;

type StartedLoginIntent = {
  intent: ConnectIntentCreation;
  pendingAuth: PendingConnectAuth;
};

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readBrowserMessageEvents(): ConnectPopupMessageEvents | undefined {
  const addEventListener = Reflect.get(globalThis, 'addEventListener');
  const removeEventListener = Reflect.get(globalThis, 'removeEventListener');
  if (typeof addEventListener !== 'function' || typeof removeEventListener !== 'function') {
    return undefined;
  }

  return {
    subscribe(listener) {
      const domListener = (event: unknown): void => {
        if (isConnectPopupMessageEvent(event)) {
          listener({ origin: event.origin, data: event.data });
        }
      };
      addEventListener.call(globalThis, 'message', domListener);
      return () => {
        removeEventListener.call(globalThis, 'message', domListener);
      };
    },
  };
}

function isConnectPopupMessageEvent(value: unknown): value is ConnectPopupMessageEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'origin' in value &&
    typeof value.origin === 'string' &&
    'data' in value
  );
}

function toRejectionError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
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
