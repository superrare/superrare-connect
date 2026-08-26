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
import { SuperRareConnectApiError } from './errors.js';
import {
  readConnectSessionFromStorage,
  removeConnectSessionFromStorage,
  writeConnectSessionToStorage,
  type ConnectSession,
  type ConnectSessionStorage,
} from './session-storage-core.js';
import {
  appendConnectPopupDisplay,
  getConnectPopupDeadline,
  getConnectPopupFeatures,
  isConnectIntentSettled,
  isRetryableConnectApiStatus,
  type ConnectPopupOpener,
  type ConnectPopupSize,
  type ConnectPopupWindow,
} from './popup-core.js';
import {
  parseConnectAuthCallbackMessage,
  resolveConnectHostedUrl,
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
   * Popup mode only. Called with the terminal status when the flow finishes
   * (the SDK closes the window); with `status: 'expired'` when the server
   * reports the intent expired (the window is left open — the hosted page may
   * be mid-payment, and only it knows whether closing is safe); or with the
   * latest known state when the user closes the popup early or the SDK's
   * fallback deadline lapses — those two can carry a non-terminal status, so
   * check `intent.status` before treating the flow as finished. Not called
   * when the intent cannot be read at all and nothing was ever known.
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

/**
 * Thrown by `exchangeCallback`/`exchangeCode` when the session changed while
 * the exchange was in flight (a logout or a newer login on this client). The
 * exchanged session is deliberately NOT stored — committing it would resurrect
 * a session the caller already moved on from.
 */
export class ConnectSessionSupersededError extends Error {
  readonly code = 'session_superseded';

  constructor() {
    super('The Connect session changed while the login was completing.');
    this.name = 'ConnectSessionSupersededError';
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
  // Per client: bumped by every session commit or clear on THIS client, so an
  // exchange that resolves after this client's session changed underneath it
  // (a logout, a newer login) does not write a stale result back. A separate
  // client instance — a different `sessionStorageKey`, a different widget — is
  // an independent session and does not invalidate this one.
  let sessionCommitGeneration = 0;
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
  // The single place a session is written: bumps the generation, persists,
  // notifies. `clearPendingAuth` is false for the popup path, which never
  // owned the shared pending record.
  const commitSession = (
    session: ConnectSession,
    { clearPendingAuth }: { clearPendingAuth: boolean },
  ): void => {
    sessionCommitGeneration += 1;
    writeConnectSessionToStorage(storage, storageKey, session);
    if (clearPendingAuth) {
      removePendingAuthFromStorage(storage, pendingAuthStorageKey);
    }
    notifySessionListeners(sessionListeners, session);
  };
  const exchangeCode = async (params: ConnectAuthCallbackParams): Promise<ConnectSession> => {
    const generation = sessionCommitGeneration;
    const session = await exchangeConnectAuthCode(params, apiOptions);
    if (generation !== sessionCommitGeneration) {
      // A logout or newer login landed on this client during the exchange, so
      // the stale session must not be written. Drop the now-consumed pending
      // record too — but only if it is still THIS callback's, since a
      // concurrent redirect login may have replaced it — so replaying this
      // callback fails locally instead of sending the spent code to the backend.
      const storedPendingAuth = readPendingAuthFromStorage(storage, pendingAuthStorageKey);
      if (storedPendingAuth?.intentId === params.intentId) {
        removePendingAuthFromStorage(storage, pendingAuthStorageKey);
      }

      throw new ConnectSessionSupersededError();
    }

    commitSession(session, { clearPendingAuth: true });
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
  const watchPopupIntent = async (input: {
    popup: ConnectPopupWindow;
    intentId: string;
    deadline: number;
  }): Promise<void> => {
    // Kept across ticks: a transient poll failure must not erase the state we
    // already know, or an early close would have nothing to report.
    let lastIntent: ConnectIntent | undefined;
    // When the current tick's poll failed, lastIntent is at least one interval
    // old — and people close the window right when the status changes, so an
    // early close re-reads before reporting instead of handing back a stale
    // `processing` for a payment that just completed.
    let lastPollFailed = false;
    let consecutiveGoneResponses = 0;
    const closePopup = (): void => {
      try {
        if (!isPopupClosed(input.popup)) input.popup.close();
      } catch {
        // An integrator-supplied window whose close() throws must not swallow
        // the report that follows.
      }
    };
    const pollIntent = async (): Promise<ConnectIntent> =>
      await getConnectIntent({
        ...apiOptions,
        intentId: input.intentId,
        signal: createRequestTimeoutSignal(POPUP_INTENT_POLL_TIMEOUT_MS),
      });

    // The window is only ever closed from here on a KNOWN terminal status. In
    // every other stop the hosted page keeps the window: it may be mid-payment
    // or showing its own outcome, and the SDK cannot know closing is safe.
    for (;;) {
      await sleep(POPUP_POLL_INTERVAL_MS);
      try {
        lastIntent = await pollIntent();
        lastPollFailed = false;
        consecutiveGoneResponses = 0;
      } catch (error) {
        lastPollFailed = true;
        if (
          !(error instanceof SuperRareConnectApiError) ||
          isRetryableConnectApiStatus(error.status)
        ) {
          // A retryable failure between two gone answers breaks the streak:
          // the threshold means consecutive, or it means nothing.
          consecutiveGoneResponses = 0;
        } else {
          // One 4xx can be edge infrastructure having a moment; two in a row
          // is the server's answer. Rare API never writes an `expired` status
          // to the intent itself — expiry IS this 410 — so that answer is
          // reported as the terminal state it means. A 404 (evicted, unknown)
          // leaves nothing honest to report.
          consecutiveGoneResponses += 1;
          if (consecutiveGoneResponses >= POPUP_INTENT_GONE_CONFIRMATIONS) {
            if (error.status === 410 && lastIntent !== undefined) {
              options.onIntentSettled?.({ ...lastIntent, status: 'expired' });
            }
            return;
          }
        }
      }

      if (lastIntent !== undefined && isConnectIntentSettled(lastIntent.status)) {
        closePopup();
        options.onIntentSettled?.(lastIntent);
        return;
      }

      if (isPopupClosed(input.popup)) {
        // The user dismissed the popup; report the latest state. One bounded
        // read backs the documented contract when nothing is known yet or the
        // known state predates a failed tick.
        if (lastIntent === undefined || lastPollFailed) {
          try {
            lastIntent = await pollIntent();
          } catch (rereadError) {
            if (
              rereadError instanceof SuperRareConnectApiError &&
              !isRetryableConnectApiStatus(rereadError.status)
            ) {
              // Same policy as the loop above: a disowned intent must not be
              // replayed as still in flight from a stale snapshot. 410 IS the
              // expiry; anything else gone leaves nothing honest to report.
              if (rereadError.status === 410 && lastIntent !== undefined) {
                options.onIntentSettled?.({ ...lastIntent, status: 'expired' });
              }
              return;
            }
            // A retryable blip: the last known state is the best we have.
          }
        }

        if (lastIntent !== undefined) options.onIntentSettled?.(lastIntent);
        return;
      }

      if (Date.now() >= input.deadline) {
        // Fallback only: real expiry arrives as the 410 above. This fires when
        // the client clock runs well ahead of the server or the server has
        // been unreachable past the intent's whole lifetime — polling further
        // would run for the life of the page.
        if (lastIntent !== undefined) options.onIntentSettled?.(lastIntent);
        return;
      }
    }
  };
  // Every hosted URL the SDK navigates a window to crosses this guard: the
  // URL comes from Rare API, but a `javascript:`/`data:` URL reaching
  // `location.replace`/`assign` would execute, so only web URLs are allowed.
  const requireNavigableHostedUrl = (url: string): string => {
    const hostedUrl = resolveConnectHostedUrl(url);
    if (!hostedUrl.ok) {
      // Carry the reason: `unsupported_protocol` (a rejected downgrade/executable
      // scheme) is a distinct, security-relevant signal from `unparseable`.
      throw new Error(`Invalid Connect intent URL (${hostedUrl.error}).`);
    }

    return hostedUrl.origin;
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
    // Each action gets its own window name: a shared one lets a second action
    // reuse the first's window, so one watcher could close the window a buyer
    // is paying in.
    const popup = options.display === 'popup'
      ? openPopupWindow(`superrare-connect-intent-${createConnectPopupName()}`)
      : null;
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

    try {
      requireNavigableHostedUrl(intent.url);
    } catch (error) {
      popup?.close();
      throw error;
    }

    if (popup !== null) {
      popup.location.replace(appendConnectPopupDisplay(intent.url));
      void watchPopupIntent({
        popup,
        intentId: intent.intentId,
        deadline: getConnectPopupDeadline({
          expiresAt: intent.expiresAt,
          now: Date.now(),
          fallbackMilliseconds: POPUP_FALLBACK_TIMEOUT_MS,
        }) + POPUP_INTENT_DEADLINE_GRACE_MS,
      }).catch(() => {
        // The watcher owns its own cleanup; a throwing collaborator (a custom
        // window, or the integrator's onIntentSettled) must not surface as an
        // unhandled rejection.
      });
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
  let inFlightPopupLogin: Promise<ConnectPopupLoginResult> | undefined;
  const createLoginIntent = async (
    params: ConnectAuthLoginParams,
    // Not `options`: that name belongs to the client options this closure
    // reads for initiatingOrigin.
    intentOptions: { signal?: AbortSignal } = {},
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
      signal: intentOptions.signal,
    }));
    return {
      intent,
      pendingAuth: {
        intentId: intent.intentId,
        state: requestResult.request.state,
        expiresAt: intent.expiresAt,
      },
    };
  };
  // Only a REDIRECT login needs its pending record to survive the navigation.
  // A popup login verifies its callback against the record it holds in memory,
  // so it never writes here — the single storage key stays owned by whichever
  // redirect login is actually in flight.
  const persistPendingAuth = (pendingAuth: PendingConnectAuth): void => {
    writePendingAuthToStorage(storage, pendingAuthStorageKey, pendingAuth);
  };
  const completePopupLogin = async (input: {
    params: ConnectAuthCallbackParams;
    operationGeneration: number;
    // True once the watcher settled this login (timed out, dismissed); a
    // response that arrives afterwards must not write a session behind its back.
    isAbandoned: () => boolean;
    // Signals the watcher that the session is committed, so its completion
    // deadline stops applying to the best-effort profile lookup that follows.
    onCommitted: () => void;
  }): Promise<ConnectPopupLoginResult> => {
    const session = await exchangeConnectAuthCode(input.params, {
      ...apiOptions,
      signal: createRequestTimeoutSignal(POPUP_LOGIN_COMPLETION_TIMEOUT_MS),
    });
    if (input.isAbandoned() || input.operationGeneration !== sessionCommitGeneration) {
      // The watcher gave up, or a logout/newer login landed on this client;
      // the stale session is dropped rather than written over current state.
      return { status: 'cancelled' };
    }

    // The session is established: the login has succeeded. The profile lookup
    // is best-effort — neither a failure nor a slow response may turn a
    // committed login into an error, so the watcher stops timing it here.
    commitSession(session, { clearPendingAuth: false });
    input.onCommitted();
    const user = await getConnectCurrentUser({
      ...apiOptions,
      sessionId: session.sessionId,
      signal: createRequestTimeoutSignal(POPUP_LOGIN_COMPLETION_TIMEOUT_MS),
    }).catch((): undefined => undefined);
    return { status: 'authenticated', session, user };
  };
  // A custom window (an integrator-supplied `popup.open`) could have a
  // `closed` getter that throws; treat that as still-open so a throwing getter
  // cannot crash a poll loop and leave the login unsettled — the deadline
  // still ends it.
  const isPopupClosed = (popup: ConnectPopupWindow): boolean => {
    try {
      return popup.closed;
    } catch {
      return false;
    }
  };
  // Nothing watches the popup while its intent is being created, so a window
  // closed during that gap would leave the caller unanswered. This covers it.
  const watchPopupDismissal = async (
    popup: ConnectPopupWindow,
    isSettled: () => boolean,
  ): Promise<'dismissed' | 'settled'> => {
    while (!isSettled()) {
      await sleep(POPUP_POLL_INTERVAL_MS);
      if (isSettled()) break;
      if (isPopupClosed(popup)) return 'dismissed';
    }

    return 'settled';
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
      // The hosted page closes itself right after posting the callback, so the
      // close-watcher stands down once an exchange is in flight. The
      // completion deadline then bounds the exchange — but only until the
      // session is committed (`committed`), after which the login has already
      // succeeded and the profile lookup is on its own request timeout.
      let exchanging = false;
      let committed = false;
      let completionDeadline = 0;
      let unsubscribe: () => void = () => {};
      // Cleanup is best-effort: an integrator-supplied window or emitter may
      // throw on close/unsubscribe, but a login that reached a decision must
      // still settle, so the error is swallowed and `finish` always runs.
      const settle = (finish: () => void): void => {
        if (settled) return;
        settled = true;
        try {
          unsubscribe();
          if (!isPopupClosed(input.popup)) input.popup.close();
        } catch {
          // The window/emitter is already gone; nothing left to release.
        }
        finish();
      };

      unsubscribe = input.messageEvents.subscribe((event) => {
        if (settled || exchanging) return;
        const parsed = parseConnectAuthCallbackMessage({
          data: event.data,
          origin: event.origin,
          expectedOrigin: input.connectOrigin,
        });
        // Unrelated or foreign-origin messages — keep waiting. A callback for
        // another intent belongs to a different login, not this one.
        if (!parsed.ok || parsed.params.intentId !== input.pendingAuth.intentId) return;

        // Verified against this login's own record, so storage-disabled
        // clients cannot be confused by an unrelated pending record.
        const verification = verifyConnectAuthCallbackAgainstPending({
          pendingAuth: input.pendingAuth,
          callbackParams: parsed.params,
        });
        if (!verification.ok) {
          settle(() => {
            reject(new ConnectAuthPendingError(verification.error));
          });
          return;
        }

        // A callback in hand is exchanged regardless of the client clock: the
        // server is the authority on expiry and returns 410 for a spent
        // intent. The client deadline only closes an abandoned popup.
        exchanging = true;
        completionDeadline = Date.now() + POPUP_LOGIN_COMPLETION_TIMEOUT_MS;
        completePopupLogin({
          params: parsed.params,
          operationGeneration: input.operationGeneration,
          isAbandoned: () => settled,
          onCommitted: () => {
            committed = true;
          },
        }).then(
          (result) => {
            settle(() => {
              resolve(result);
            });
          },
          (error: unknown) => {
            settle(() => {
              reject(toRejectionError(error));
            });
          },
        );
      });

      const watchPopupLifetime = async (): Promise<void> => {
        while (!settled) {
          await sleep(POPUP_POLL_INTERVAL_MS);
          if (settled) continue;

          if (exchanging) {
            // The window is gone by design; the deadline applies only until
            // the session is committed — after that the login has won.
            if (!committed && Date.now() >= completionDeadline) {
              settle(() => {
                reject(new Error('Timed out completing the Connect login.'));
              });
              return;
            }

            continue;
          }

          if (isPopupClosed(input.popup)) {
            settle(() => {
              resolve({ status: 'cancelled' });
            });
            return;
          }
          if (Date.now() >= input.deadline) {
            settle(() => {
              resolve({ status: 'expired' });
            });
            return;
          }
        }
      };
      void watchPopupLifetime();
    });

  const runPopupLogin = async (
    params: ConnectAuthLoginParams,
  ): Promise<ConnectPopupLoginResult> => {
    // A logout or another login on this client after this point invalidates
    // the whole operation, so its exchange can never resurrect a replaced
    // session.
    const operationGeneration = sessionCommitGeneration;
    // The popup must open before the first await to stay inside the user
    // gesture; it navigates once the intent exists. Without a message source
    // the callback could never be received, so don't open one — the flow
    // falls back to the redirect login instead.
    const popup = messageEvents === undefined
      ? null
      : openPopupWindow(`superrare-connect-login-${createConnectPopupName()}`);
    if (popup === null && storage === undefined) {
      // The redirect fallback verifies its callback against the STORED pending
      // record, so without storage it could never complete.
      throw new Error(
        messageEvents === undefined
          ? 'Popup login is unavailable (no message-event source), and the redirect fallback requires session storage.'
          : 'The Connect popup could not be opened, and the redirect login fallback requires session storage.',
      );
    }

    let creationSettled = false;
    const creation = createLoginIntent(params, {
      signal: createRequestTimeoutSignal(LOGIN_INTENT_TIMEOUT_MS),
    }).finally(() => {
      creationSettled = true;
    });

    let started: StartedLoginIntent;
    try {
      const raced = popup === null
        ? { created: await creation }
        : await Promise.race([
          creation.then((created) => ({ created })),
          watchPopupDismissal(popup, () => creationSettled).then(
            (dismissal) => ({ dismissal }),
          ),
        ]);

      if ('dismissal' in raced && raced.dismissal === 'dismissed') {
        popup?.close();
        return { status: 'cancelled' };
      }

      started = 'created' in raced ? raced.created : await creation;
    } catch (error) {
      popup?.close();
      throw error;
    }

    const { intent, pendingAuth } = started;
    // Creating the intent is a round trip; a logout during it invalidates this
    // login before anything is stored or navigated.
    if (operationGeneration !== sessionCommitGeneration) {
      popup?.close();
      return { status: 'cancelled' };
    }

    let connectOrigin: string;
    try {
      connectOrigin = requireNavigableHostedUrl(intent.url);
    } catch (error) {
      popup?.close();
      throw error;
    }

    if (popup === null || messageEvents === undefined) {
      // Popup blocked: fall back to the redirect login. Only now is the
      // pending record stored — it has to survive the navigation. Like
      // `auth.login`, the redirect flow keeps a single pending record, so a
      // concurrent redirect login on the same client replaces it (last wins).
      persistPendingAuth(pendingAuth);
      navigation?.assign(intent.url);
      return { status: 'redirected', intent };
    }

    const popupUrl = appendConnectPopupDisplay(intent.url);
    const deadline = getConnectPopupDeadline({
      expiresAt: intent.expiresAt,
      now: Date.now(),
      fallbackMilliseconds: POPUP_FALLBACK_TIMEOUT_MS,
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
      // The watcher settles and cleans up on its own; this boundary covers a
      // collaborator that throws (navigation, subscription) before the watcher
      // owns the cleanup. Closing twice is harmless.
      if (!popup.closed) popup.close();
      throw error;
    }
  };

  return {
    auth: {
      async login(params = {}): Promise<ConnectIntentCreation> {
        const { intent, pendingAuth } = await createLoginIntent(params, {
          signal: createRequestTimeoutSignal(LOGIN_INTENT_TIMEOUT_MS),
        });
        // Guard before anything is stored, so a rejected URL leaves no
        // pending record behind.
        requireNavigableHostedUrl(intent.url);
        persistPendingAuth(pendingAuth);
        navigation?.assign(intent.url);
        return intent;
      },
      async loginWithPopup(params = {}): Promise<ConnectPopupLoginResult> {
        // One login at a time: the SDK holds a single session, so a second
        // concurrent login could only race the first for the same slot. A
        // caller that asks again — a double click — joins the login already
        // running instead of opening a second window.
        inFlightPopupLogin ??= runPopupLogin(params).finally(() => {
          inFlightPopupLogin = undefined;
        });

        return await inFlightPopupLogin;
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
        sessionCommitGeneration += 1;
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
/** Bounds one status poll so a hung request cannot stall the whole watcher. */
const POPUP_INTENT_POLL_TIMEOUT_MS = 15_000;
/** Non-retryable poll answers required before the watcher believes them. */
const POPUP_INTENT_GONE_CONFIRMATIONS = 2;
/** Deadline for a popup whose intent carries an unusable expiry. */
const POPUP_FALLBACK_TIMEOUT_MS = 15 * 60_000;
/**
 * Keep the client-side deadline a little past the intent's expiry so under
 * small clock skew the server's own 410 — not a synthetic client stop — is
 * what decides that the intent expired.
 */
const POPUP_INTENT_DEADLINE_GRACE_MS = 30_000;
/**
 * Once the callback arrives the exchange is seconds away from done, so it gets
 * a deadline of its own: the intent's expiry can be minutes out, and leaving
 * the caller waiting that long on an unresponsive backend is indistinguishable
 * from a hang. This bounds only the exchange — once the session is committed
 * the login has succeeded and the profile lookup is best-effort.
 */
const POPUP_LOGIN_COMPLETION_TIMEOUT_MS = 20_000;
/**
 * Creating the intent is the one call the caller waits on before anything is
 * watching, so it is bounded too — generously, since it happens before the
 * user has invested anything in the flow.
 */
const LOGIN_INTENT_TIMEOUT_MS = 30_000;

/**
 * An abort signal that fires after `milliseconds`. Uses `AbortSignal.timeout`
 * where available, and falls back to a plain timer + controller on older
 * runtimes so the timeout guarantee never depends on the platform. Returns
 * undefined only where the platform has no `AbortController` at all.
 */
const createRequestTimeoutSignal = (
  milliseconds: number,
): AbortSignal | undefined => {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(milliseconds);
  }

  if (typeof AbortController === 'undefined') {
    return undefined;
  }

  const controller = new AbortController();
  // The timer always fires at `milliseconds`; aborting an already-settled
  // request is a harmless no-op. `unref` (Node) keeps a pending timer from
  // holding the process open after the work is done.
  const timer: unknown = setTimeout(() => {
    controller.abort();
  }, milliseconds);
  if (typeof timer === 'object' && timer !== null && 'unref' in timer && typeof timer.unref === 'function') {
    timer.unref();
  }

  return controller.signal;
};

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

/**
 * A browsing-context name unique across the page, so concurrent popup logins —
 * even from separate client instances or two copies of the SDK — never share a
 * window. Randomness needs no cryptographic strength here; it only avoids
 * collisions, and falls back when `crypto.randomUUID` is absent.
 */
function createConnectPopupName(): string {
  const randomUuid = globalThis.crypto?.randomUUID;
  if (typeof randomUuid === 'function') {
    return randomUuid.call(globalThis.crypto);
  }

  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
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
