import { z } from 'zod';
import {
  claimConnectAuthCode,
  createConnectIntent,
  createConnectLoginIntent,
  exchangeConnectAuthCode,
  getConnectCheckoutStatus,
  getConnectCurrentUser,
  getConnectIntent,
  getConnectSession,
  type ConnectAuthCredentials,
  type ConnectAuthApiOptions,
  type ConnectCurrentUser,
  type ConnectIntentCreation,
  type ConnectSessionState,
} from './api.js';
import {
  type BuildConnectActionIntentRequestResult,
  buildConnectAcceptOfferIntentRequest,
  buildConnectBidIntentRequest,
  buildConnectBuyIntentRequest,
  buildConnectCancelOfferIntentRequest,
  buildConnectMakeOfferIntentRequest,
  buildConnectMintIntentRequest,
  buildConnectSellIntentRequest,
  buildConnectSettleIntentRequest,
  buildConnectTransferIntentRequest,
  type AcceptOfferActionParams,
  type BidActionParams,
  type BuyActionParams,
  type CancelOfferActionParams,
  type ConnectActionValidationErrorCode,
  type MakeOfferActionParams,
  type MintActionParams,
  type SellActionParams,
  type SettleActionParams,
  type TransferActionParams,
} from './actions-flow-core.js';
import {
  buildConnectLoginIntentRequest,
  verifyConnectAuthCallbackAgainstPending,
  type ConnectAuthPendingVerificationError,
  type PendingConnectAuth,
} from './auth-flow-core.js';
import type { ConnectAuthCallbackParams } from './callback-core.js';
import {
  buildConnectCheckoutIntentRequest,
  type CheckoutStartParams,
} from './checkout-flow-core.js';
import { SuperRareConnectApiError } from './errors.js';
import {
  type ConnectSession,
  type ConnectSessionStorage,
} from './session-storage-core.js';
import {
  createConnectSessionLifecycle,
  getConnectCredentialStorageKey,
} from './session-lifecycle.js';
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
import {
  parseClientScore,
  parseCreditBalance,
  parseGameSessionStart,
  parseLeaderboard,
  parseMyBest,
  parsePurchase,
  parseServerRun,
  requestStudioJson,
  type ClientAssertedScoreResult,
  type GameCreditBalance,
  type GameCreditPurchase,
  type GameLeaderboard,
  type GameLeaderboardEntry,
  type GameSessionStart,
  type ServerValidatedGameRun,
} from './games-api.js';
import {
  buildGameAuthorizationUrl,
  gameIdempotencyKeySchema,
  gameConsentRequestSchema,
  gamePendingAttemptSchema,
  gameAuthorizationSchema,
  gameTermsResponseSchema,
  inlineConsentResponseSchema,
  GameConnectionError,
  normalizeStudioUrl,
  parseGameAuthorizationMessage,
  type GameAuthorization,
  type GameCreditTerms,
  type GameConsentRequest,
  type GamePendingAttempt,
  type GamePaidConsent,
} from './games-core.js';

export type SuperRareConnectClientOptions = ConnectAuthApiOptions & {
  connectUrl?: string;
  /** Explicit SuperRare Studio API origin used only by the games namespace. */
  studioUrl?: string;
  initiatingOrigin?: string;
  createState?: () => string;
  /**
   * Every hosted flow — login, checkout, actions, offers — opens in a small
   * centered window; the integrator's page always stays put. These options
   * shape that window: its size, the opener (defaults to the browser's
   * `window.open`), and the `message`-event source the login listens on.
   */
  popup?: ConnectPopupSize & {
    open?: ConnectPopupOpener;
    /** Message-event source for the login callback; defaults to the window. */
    messageEvents?: ConnectPopupMessageEvents;
    /**
     * Page-visibility source for the login; defaults to the document. A
     * login claims its result from Rare API whenever this page becomes
     * visible again: iOS Safari suspends the page while the hosted window
     * is in front, and the callback posted meanwhile never arrives.
     */
    visibilityEvents?: ConnectPopupVisibilityEvents;
  };
  /**
   * Called with the terminal status when a hosted action/checkout flow
   * finishes (the SDK closes the window); with `status: 'expired'` when the
   * server reports the intent expired (the window is left open — the hosted
   * page may be mid-payment, and only it knows whether closing is safe); or
   * with the latest known state when the user closes the window early or the
   * SDK's fallback deadline lapses — those two can carry a non-terminal
   * status, so check `intent.status` before treating the flow as finished.
   * Not called when the intent cannot be read at all and nothing was ever
   * known.
   */
  onIntentSettled?: (intent: ConnectIntent) => void;
  sessionStorage?: ConnectSessionStorage | false;
  sessionStorageKey?: string;
};

export type ConnectPopupMessageEvent = {
  origin: string;
  data: unknown;
  source?: unknown;
};

export type ConnectPopupMessageEvents = {
  /** Subscribes to `message` events; returns the unsubscribe function. */
  subscribe: (listener: (event: ConnectPopupMessageEvent) => void) => () => void;
};

export type ConnectPopupVisibilityEvents = {
  /**
   * Subscribes to page-visibility changes (`true` when the page becomes
   * visible); returns the unsubscribe function.
   */
  subscribe: (listener: (visible: boolean) => void) => () => void;
};

export type ConnectAuthLoginParams = {
  returnPath?: string;
  initiatingOrigin?: string;
};

/** A login intent created ahead of the tap by `auth.prepareLogin`. */
export type ConnectPreparedLogin = {
  intentId: string;
  expiresAt: string;
};

export type SuperRareConnectAuthNamespace = {
  login: (params?: ConnectAuthLoginParams) => Promise<ConnectPopupLoginResult>;
  /** @deprecated `login` opens the window itself now; this is the same call. */
  loginWithPopup: (params?: ConnectAuthLoginParams) => Promise<ConnectPopupLoginResult>;
  /**
   * Creates the login intent ahead of the tap, so the next `login` with the
   * same params opens the hosted window already pointed at it — inside the
   * gesture, with no round trip in between. That round trip is what a
   * suspended opener (iOS Safari, the moment the window takes focus) never
   * finishes, leaving the window blank. Call it when the page loads or when
   * the person is about to tap. A prepared login lasts as long as its
   * intent; `login` drops a stale or mismatched one and creates a fresh
   * intent instead.
   */
  prepareLogin: (params?: ConnectAuthLoginParams) => Promise<ConnectPreparedLogin>;
  getSession: () => ConnectSession | undefined;
  /** Returns a current opaque access token, renewing the session when necessary. */
  getAccessToken: () => Promise<string>;
  getRemoteSession: () => Promise<ConnectSessionState>;
  me: () => Promise<ConnectCurrentUser>;
  logout: () => Promise<void>;
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
  sell: (params: SellActionParams) => Promise<ConnectIntentCreation>;
  bid: (params: BidActionParams) => Promise<ConnectIntentCreation>;
  mint: (params: MintActionParams) => Promise<ConnectIntentCreation>;
  settle: (params: SettleActionParams) => Promise<ConnectIntentCreation>;
  transfer: (params: TransferActionParams) => Promise<ConnectIntentCreation>;
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

export type SuperRareGameStartParams = {
  idempotencyKey?: string;
  clientSessionId?: string;
  clientBuildId?: string;
  metadata?: Record<string, unknown>;
};

export type SuperRareGameClient = {
  /** Starts a free session. Credit-gated games require inline consent. */
  start: (params?: SuperRareGameStartParams) => Promise<GameSessionStart>;
  /** Explicit connection or renewal only; never authorizes a play. */
  connect: () => Promise<GameAuthorization>;
  /** Reads valid game-scoped authorization without opening or renewing a popup. */
  getAuthorization: () => GameAuthorization | undefined;
  getTerms: () => Promise<GameCreditTerms>;
  /** Call only after the game displays and receives one-play confirmation. */
  requestConsent: (params: SuperRareGameStartParams & {
    idempotencyKey: string; fingerprint: string; expectedCredits: number;
  }) => Promise<{ consent: GamePaidConsent; recovery: 'persistent' | 'memory' }>;
  startWithConsent: (params: SuperRareGameStartParams & { idempotencyKey: string; consent: GamePaidConsent }) => Promise<GameSessionStart>;
  /** Recovers a consent/start saved before a lost response or page reload. */
  recoverStart: (params: SuperRareGameStartParams & { idempotencyKey: string }) => Promise<GameSessionStart>;
  complete: (params: { sessionId: string; sessionToken: string }) => Promise<{ completed: true; idempotentReplay: boolean }>;
  /** Client-provided scores are session-bound assertions, never authoritative server validation. */
  submitClientAssertedScore: (params: {
    sessionToken: string; leaderboardKey?: string; seasonKey?: string; score: number;
    idempotencyKey: string; secondaryValue?: number; metadata?: Record<string, unknown>;
  }) => Promise<ClientAssertedScoreResult>;
  startServerValidatedRun: (params: { sessionToken: string; eventId: string; idempotencyKey: string }) => Promise<ServerValidatedGameRun>;
  getLeaderboard: (params?: { leaderboardKey?: string; seasonKey?: string; limit?: number; cursor?: string }) => Promise<GameLeaderboard>;
  getMyBest: (params: { sessionToken: string; leaderboardKey?: string; seasonKey?: string }) => Promise<GameLeaderboardEntry | null>;
  credits: {
    getBalance: () => Promise<GameCreditBalance>;
    createPurchase: () => Promise<GameCreditPurchase>;
    getPurchase: (purchaseId: string) => Promise<GameCreditPurchase>;
    claimPurchase: (params: { purchaseId: string; transactionHash: string }) => Promise<{ purchase: GameCreditPurchase; balance: GameCreditBalance }>;
  };
};

export type SuperRareConnectGamesNamespace = {
  forGame: (params: { appId: string; groupId?: string }) => SuperRareGameClient;
};

export type SuperRareConnectClient = {
  auth: SuperRareConnectAuthNamespace;
  user: SuperRareConnectUserNamespace;
  checkout: SuperRareConnectCheckoutNamespace;
  actions: SuperRareConnectActionsNamespace;
  offers: SuperRareConnectOffersNamespace;
  intents: SuperRareConnectIntentsNamespace;
  games: SuperRareConnectGamesNamespace;
};

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

export class ConnectActionValidationError extends Error {
  readonly code: ConnectActionValidationErrorCode;

  constructor(code: ConnectActionValidationErrorCode) {
    super(`Invalid Connect action parameters: ${code}.`);
    this.name = 'ConnectActionValidationError';
    this.code = code;
  }
}

export class ConnectSessionRequiredError extends Error {
  constructor() {
    super('A Connect session is required.');
    this.name = 'ConnectSessionRequiredError';
  }
}

/**
 * Thrown when the hosted window could not be opened — the opener refused
 * (popup blocked) or the host has no `window.open` at all. Every hosted flow
 * needs its own window, so there is nothing to fall back to: call the SDK
 * synchronously from a user gesture (a click handler) and the browser will
 * allow the window.
 */
export class ConnectPopupBlockedError extends Error {
  readonly code = 'popup_blocked';

  constructor() {
    super(
      'The Connect window could not be opened. Call the SDK directly from a user gesture (a click handler), and check that popups are allowed for this site.',
    );
    this.name = 'ConnectPopupBlockedError';
  }
}

const DEFAULT_CONNECT_SESSION_STORAGE_KEY = 'superrare.connect.session';

export function createSuperRareClient(
  options: SuperRareConnectClientOptions = {},
): SuperRareConnectClient {
  const storage = resolveConnectSessionStorage(options.sessionStorage);
  const storageKey = getConnectCredentialStorageKey(
    options.sessionStorageKey ?? DEFAULT_CONNECT_SESSION_STORAGE_KEY,
    options.apiUrl,
  );
  // Login/preparation generations belong to this client. Credential renewal
  // coordination belongs to the shared storage slot.
  let sessionCommitGeneration = 0;
  const apiOptions = {
    apiUrl: options.apiUrl,
    fetch: options.fetch,
  };
  const sessionLifecycle = createConnectSessionLifecycle({ storage, storageKey, apiOptions });
  const resolveHostedIntent = (intent: ConnectIntentCreation): ConnectIntentCreation => ({
    ...intent,
    url: resolveHostedConnectUrl({
      connectUrl: options.connectUrl,
      url: intent.url,
    }),
  });
  const createState = options.createState ?? createConnectState;
  const commitSession = async (
    credentials: ConnectAuthCredentials,
    shouldCommit: () => boolean,
  ): Promise<boolean> => {
    const committed = await sessionLifecycle.commit(credentials, shouldCommit);
    if (committed) sessionCommitGeneration += 1;
    return committed;
  };
  // `url` is the page the window opens at. A flow whose intent already
  // exists opens straight at the hosted page; the others open blank and
  // navigate once their intent is created.
  const openPopupWindow = (
    target = 'superrare-connect',
    url = 'about:blank',
  ): ConnectPopupWindow | null => {
    const open = options.popup?.open ?? readBrowserPopupOpener();
    if (open === undefined) return null;

    const screen = readBrowserScreenSize();
    return open(
      url,
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
          // Rare API never writes an `expired` status to the intent itself —
          // expiry IS a 410, and nothing at the edge fakes that status — so a
          // single one is definitive and is reported as the terminal state it
          // means. The ambiguous 4xxs (a 403 from a WAF, a 404 off a stale
          // replica) get one benefit of the doubt: two in a row is the
          // server's answer, and a 404 leaves nothing honest to report.
          if (error.status === 410) {
            if (lastIntent !== undefined) {
              options.onIntentSettled?.({ ...lastIntent, status: 'expired' });
            }
            return;
          }

          consecutiveGoneResponses += 1;
          if (consecutiveGoneResponses >= POPUP_INTENT_GONE_CONFIRMATIONS) {
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
    requestResult: BuildConnectActionIntentRequestResult,
  ): Promise<ConnectIntentCreation> => {
    if (!requestResult.ok) {
      throw requestResult.error === 'invalid_return_path'
        ? new ConnectReturnPathError()
        : new ConnectActionValidationError(requestResult.error);
    }

    // The popup must open before the first await to stay inside the user
    // gesture; otherwise browsers block it. It navigates once the intent
    // exists. A blocked window fails the whole call before any intent is
    // created — there is no same-page fallback. Each action gets its own
    // window name: a shared one lets a second action reuse the first's
    // window, so one watcher could close the window a buyer is paying in.
    const popup = openPopupWindow(`superrare-connect-intent-${createConnectPopupName()}`);
    if (popup === null) {
      throw new ConnectPopupBlockedError();
    }

    let intent: ConnectIntentCreation;
    try {
      intent = resolveHostedIntent(await createConnectIntent({
        ...apiOptions,
        request: requestResult.request,
      }));
      requireNavigableHostedUrl(intent.url);
    } catch (error) {
      popup.close();
      throw error;
    }

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

    return intent;
  };
  const me = async (): Promise<ConnectCurrentUser> => {
    const session = await sessionLifecycle.getCurrentSession();
    if (session === undefined) {
      throw new ConnectSessionRequiredError();
    }

    return await getConnectCurrentUser({
      ...apiOptions,
      sessionId: session.sessionId,
    });
  };
  const messageEvents = options.popup?.messageEvents ?? readBrowserMessageEvents();
  const visibilityEvents = options.popup?.visibilityEvents ?? readBrowserVisibilityEvents();
  let popupLoginReplacementGeneration = 0;
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
  // The login prepared ahead of the tap, if any. Held in memory only: it is
  // tied to this client's session generation (a logout invalidates it) and
  // to the params it was prepared with.
  let preparedLogin: PreparedLogin | undefined;
  const resolveLoginParams = (params: ConnectAuthLoginParams): ResolvedLoginParams => ({
    returnPath: params.returnPath,
    initiatingOrigin: params.initiatingOrigin ?? options.initiatingOrigin ?? readBrowserOrigin(),
  });
  const prepareLogin = async (
    params: ConnectAuthLoginParams = {},
  ): Promise<ConnectPreparedLogin> => {
    const resolvedParams = resolveLoginParams(params);
    const existing = preparedLogin;
    if (
      existing !== undefined &&
      existing.operationGeneration === sessionCommitGeneration &&
      isPreparedLoginUsable({ prepared: existing, params: resolvedParams, now: Date.now() })
    ) {
      return {
        intentId: existing.started.intent.intentId,
        expiresAt: existing.started.intent.expiresAt,
      };
    }

    const operationGeneration = sessionCommitGeneration;
    const started = await createLoginIntent(params, {
      signal: createRequestTimeoutSignal(LOGIN_INTENT_TIMEOUT_MS),
    });
    const connectOrigin = requireNavigableHostedUrl(started.intent.url);
    preparedLogin = {
      started,
      connectOrigin,
      popupUrl: appendConnectPopupDisplay(started.intent.url),
      params: resolvedParams,
      operationGeneration,
    };
    return {
      intentId: started.intent.intentId,
      expiresAt: started.intent.expiresAt,
    };
  };
  // Hands the prepared login over to a `login` call, once: a stale or
  // mismatched one is dropped, and the call creates its own intent.
  const takePreparedLogin = (params: ConnectAuthLoginParams): PreparedLogin | undefined => {
    const prepared = preparedLogin;
    preparedLogin = undefined;
    if (prepared === undefined) return undefined;
    if (prepared.operationGeneration !== sessionCommitGeneration) return undefined;
    if (!isPreparedLoginUsable({ prepared, params: resolveLoginParams(params), now: Date.now() })) {
      return undefined;
    }

    return prepared;
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
    const credentials = await exchangeConnectAuthCode(input.params, {
      ...apiOptions,
      signal: createRequestTimeoutSignal(POPUP_LOGIN_COMPLETION_TIMEOUT_MS),
    });
    const committed = await commitSession(credentials, () => {
      const currentSession = sessionLifecycle.getSession();
      return !input.isAbandoned() &&
        input.operationGeneration === sessionCommitGeneration &&
        (currentSession === undefined ||
          sessionLifecycle.getReplacementGeneration() === popupLoginReplacementGeneration);
    });
    if (!committed) return { status: 'cancelled' };

    // The session is established: the login has succeeded. The profile lookup
    // is best-effort — neither a failure nor a slow response may turn a
    // committed login into an error, so the watcher stops timing it here.
    const session = credentials.session;
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
    visibilityEvents: ConnectPopupVisibilityEvents | undefined;
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
      // A claim in flight: the close-watcher waits for its answer rather than
      // reporting a cancel for a login that may just have completed.
      let claiming = false;
      let unsubscribe: () => void = () => {};
      let unsubscribeVisibility: () => void = () => {};
      // Cleanup is best-effort: an integrator-supplied window or emitter may
      // throw on close/unsubscribe, but a login that reached a decision must
      // still settle, so the error is swallowed and `finish` always runs.
      const settle = (finish: () => void): void => {
        if (settled) return;
        settled = true;
        try {
          unsubscribe();
          unsubscribeVisibility();
          if (!isPopupClosed(input.popup)) input.popup.close();
        } catch {
          // The window/emitter is already gone; nothing left to release.
        }
        finish();
      };

      // One exchange per login, whichever delivery arrives first: the posted
      // callback or a claim. A code the other path minted afterwards is
      // simply never used (it expires with the intent).
      const startExchange = (params: ConnectAuthCallbackParams): void => {
        // Verified against this login's own record, so storage-disabled
        // clients cannot be confused by an unrelated pending record.
        const verification = verifyConnectAuthCallbackAgainstPending({
          pendingAuth: input.pendingAuth,
          callbackParams: params,
        });
        if (!verification.ok) {
          settle(() => {
            reject(new ConnectAuthPendingError(verification.error));
          });
          return;
        }

        // A code in hand is exchanged regardless of the client clock: the
        // server is the authority on expiry and returns 410 for a spent
        // intent. The client deadline only closes an abandoned popup.
        exchanging = true;
        completionDeadline = Date.now() + POPUP_LOGIN_COMPLETION_TIMEOUT_MS;
        completePopupLogin({
          params,
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

        startExchange(parsed.params);
      });

      // The pull side of the handoff. The hosted page posts its callback to
      // this page, but iOS Safari suspends this page while the hosted window
      // is in front and the message posted meanwhile never arrives. So on
      // every occasion this page may have missed it — becoming visible again,
      // finding the window closed — Rare API is asked for the result: a fresh
      // code once the hosted login completed, 409 until then.
      const claimCompletedLogin = async (): Promise<void> => {
        if (settled || exchanging || claiming) return;
        claiming = true;
        try {
          const claim = await claimConnectAuthCode(
            { intentId: input.pendingAuth.intentId, state: input.pendingAuth.state },
            { ...apiOptions, signal: createRequestTimeoutSignal(POPUP_LOGIN_COMPLETION_TIMEOUT_MS) },
          );
          // The posted callback may have landed while the claim was out.
          if (settled || exchanging || claim.status === 'not_completed') return;

          startExchange(claim.params);
        } catch (error) {
          if (settled || exchanging) return;
          if (error instanceof SuperRareConnectApiError && !isRetryableConnectApiStatus(error.status)) {
            // 410 IS the expiry. Anything else non-retryable (the intent gone,
            // its state refused) means this login can no longer complete.
            if (error.status === 410) {
              settle(() => {
                resolve({ status: 'expired' });
              });
              return;
            }

            settle(() => {
              reject(error);
            });
          }
          // A retryable failure: the next occasion asks again.
        } finally {
          claiming = false;
        }
      };

      unsubscribeVisibility = input.visibilityEvents?.subscribe((visible) => {
        if (visible) void claimCompletedLogin();
      }) ?? ((): void => {});

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
            // The hosted page closes itself once it has posted the callback:
            // a closed window is where a missed callback is most likely, so
            // it is a cancel only once Rare API confirms nothing completed.
            if (!claiming) await claimCompletedLogin();
            if (settled || exchanging || claiming) continue;

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
    const prepared = takePreparedLogin(params);
    sessionCommitGeneration += 1;
    const operationGeneration = sessionCommitGeneration;
    popupLoginReplacementGeneration = sessionLifecycle.getReplacementGeneration();
    if (messageEvents === undefined) {
      // Without a message source the hosted page's callback could never be
      // received, so the login could never complete — refuse before opening
      // anything. Browsers always have one; a non-browser host supplies
      // `popup.messageEvents`.
      throw new Error(
        'Connect login is unavailable: no message-event source. Provide popup.messageEvents on hosts without window message events.',
      );
    }

    // The popup must open before the first await to stay inside the user
    // gesture; it navigates once the intent exists. A blocked window fails
    // the login before any intent is created — there is no same-page
    // fallback. A login prepared ahead of the tap has its intent already:
    // the window opens straight at the hosted page, with no round trip for a
    // suspended opener to leave unfinished.
    const popup = openPopupWindow(
      `superrare-connect-login-${createConnectPopupName()}`,
      prepared?.popupUrl,
    );
    if (popup === null) {
      throw new ConnectPopupBlockedError();
    }

    if (prepared !== undefined) {
      try {
        return await watchPopupLogin({
          popup,
          pendingAuth: prepared.started.pendingAuth,
          messageEvents,
          visibilityEvents,
          connectOrigin: prepared.connectOrigin,
          deadline: getConnectPopupDeadline({
            expiresAt: prepared.started.intent.expiresAt,
            now: Date.now(),
            fallbackMilliseconds: POPUP_FALLBACK_TIMEOUT_MS,
          }),
          operationGeneration,
        });
      } catch (error) {
        if (!popup.closed) popup.close();
        throw error;
      }
    }

    let creationSettled = false;
    const creation = createLoginIntent(params, {
      signal: createRequestTimeoutSignal(LOGIN_INTENT_TIMEOUT_MS),
    }).finally(() => {
      creationSettled = true;
    });

    let started: StartedLoginIntent;
    try {
      const raced = await Promise.race([
        creation.then((created) => ({ created })),
        watchPopupDismissal(popup, () => creationSettled).then(
          (dismissal) => ({ dismissal }),
        ),
      ]);

      if ('dismissal' in raced && raced.dismissal === 'dismissed') {
        popup.close();
        return { status: 'cancelled' };
      }

      started = 'created' in raced ? raced.created : await creation;
    } catch (error) {
      popup.close();
      throw error;
    }

    const { intent, pendingAuth } = started;
    // Creating the intent is a round trip; a logout during it invalidates this
    // login before anything is navigated.
    if (operationGeneration !== sessionCommitGeneration) {
      popup.close();
      return { status: 'cancelled' };
    }

    let connectOrigin: string;
    try {
      connectOrigin = requireNavigableHostedUrl(intent.url);
    } catch (error) {
      popup.close();
      throw error;
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
        visibilityEvents,
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

  const login = async (
    params: ConnectAuthLoginParams = {},
  ): Promise<ConnectPopupLoginResult> => {
    // One login at a time: the SDK holds a single session, so a second
    // concurrent login could only race the first for the same slot. A
    // caller that asks again — a double click — joins the login already
    // running instead of opening a second window.
    if (inFlightPopupLogin === undefined) {
      const pending = runPopupLogin(params).finally(() => {
        if (inFlightPopupLogin === pending) inFlightPopupLogin = undefined;
      });
      inFlightPopupLogin = pending;
    }

    return await inFlightPopupLogin;
  };

  const gameAuthorizations = new Map<string, GameAuthorization>();
  const gameConnections = new Map<string, {
    generation: number;
    promise: Promise<GameAuthorization>;
  }>();
  const gameAttempts = new Map<string, GamePendingAttempt>();
  const games: SuperRareConnectGamesNamespace = {
    forGame({ appId, groupId }): SuperRareGameClient {
      if (appId.trim().length === 0) throw new Error('games.forGame requires appId.');
      const studioUrl = options.studioUrl === undefined ? undefined : normalizeStudioUrl(options.studioUrl);
      const requireStudioUrl = (): string => {
        if (studioUrl === undefined) {
          throw new Error('The games namespace requires an explicit studioUrl.');
        }
        return studioUrl;
      };
      const gamePath = `/api/v1/games/${encodeURIComponent(appId)}`;
      const groupPath = groupId === undefined
        ? undefined
        : `/api/v1/credit-groups/${encodeURIComponent(groupId)}`;
      const requireAppOrigin = (): string => {
        const value = options.initiatingOrigin ?? readBrowserOrigin();
        if (value === undefined) throw new GameConnectionError('invalid_origin');
        const origin = new URL(value).origin;
        if (origin === 'null' || origin !== value) throw new GameConnectionError('invalid_origin');
        return origin;
      };
      const scopeKey = (): string => JSON.stringify([requireStudioUrl(), appId, groupId, options.initiatingOrigin ?? readBrowserOrigin()]);
      const authorizationStorageKey = (): string =>
        `superrare.connect.game-authorization:${encodeURIComponent(scopeKey())}`;
      const pendingConsentKey = (idempotencyKey: string): string =>
        `superrare.connect.game-attempt:${encodeURIComponent(scopeKey())}:${idempotencyKey}`;
      const paidPath = (): string => {
        if (groupPath === undefined) throw new Error('Credit operations require groupId.');
        return `${groupPath}/apps/${encodeURIComponent(appId)}`;
      };
      const readAttempt = (idempotencyKey: string): GamePendingAttempt | undefined => {
        const key = pendingConsentKey(idempotencyKey);
        const memory = gameAttempts.get(key);
        if (memory !== undefined) return memory;
        let saved: string | null | undefined;
        try { saved = storage?.getItem(key); } catch { return undefined; }
        if (saved === null || saved === undefined) return undefined;
        const value: unknown = JSON.parse(saved);
        const attempt = gamePendingAttemptSchema.parse(value);
        if (attempt.request.idempotencyKey !== idempotencyKey) throw new GameConnectionError('attempt_mismatch');
        gameAttempts.set(key, attempt);
        return attempt;
      };
      const saveAttempt = (attempt: GamePendingAttempt): 'persistent' | 'memory' => {
        const key = pendingConsentKey(attempt.request.idempotencyKey);
        gameAttempts.set(key, attempt);
        if (storage === undefined) return 'memory';
        try {
          storage.setItem(key, JSON.stringify(attempt));
          return 'persistent';
        } catch { return 'memory'; }
      };
      const clearStoredAuthorization = (
        expected: { authorizationToken: string } | { serialized: string },
      ): void => {
        const key = authorizationStorageKey();
        try {
          const serialized = storage?.getItem(key);
          if (serialized === null || serialized === undefined) return;
          if ('serialized' in expected) {
            if (serialized === expected.serialized) storage?.removeItem(key);
            return;
          }
          let value: unknown;
          try { value = JSON.parse(serialized); } catch { return; }
          const parsed = gameAuthorizationSchema.safeParse(value);
          if (parsed.success && parsed.data.authorizationToken === expected.authorizationToken) {
            storage?.removeItem(key);
          }
        } catch { /* Persistence cleanup is best-effort. */ }
      };
      const clearAuthorization = (authorization: GameAuthorization): void => {
        const key = scopeKey();
        if (gameAuthorizations.get(key)?.authorizationToken === authorization.authorizationToken) {
          gameAuthorizations.delete(key);
        }
        clearStoredAuthorization({ authorizationToken: authorization.authorizationToken });
      };
      const currentAuthorization = (): GameAuthorization | undefined => {
        const key = scopeKey();
        const cached = gameAuthorizations.get(key);
        if (cached !== undefined && Date.parse(cached.expiresAt) > Date.now()) return cached;
        if (cached !== undefined && gameAuthorizations.get(key)?.authorizationToken === cached.authorizationToken) {
          gameAuthorizations.delete(key);
        }
        let serialized: string | null | undefined;
        try { serialized = storage?.getItem(authorizationStorageKey()); } catch { return undefined; }
        if (serialized === null || serialized === undefined) return undefined;
        let value: unknown;
        try { value = JSON.parse(serialized); } catch {
          clearStoredAuthorization({ serialized });
          return undefined;
        }
        const parsed = gameAuthorizationSchema.safeParse(value);
        if (!parsed.success) {
          clearStoredAuthorization({ serialized });
          return undefined;
        }
        if (parsed.data.appId !== appId
          || parsed.data.groupId !== groupId
          || parsed.data.appOrigin !== requireAppOrigin()) {
          clearStoredAuthorization({ serialized });
          return undefined;
        }
        if (Date.parse(parsed.data.expiresAt) <= Date.now()) {
          clearAuthorization(parsed.data);
          return undefined;
        }
        gameAuthorizations.set(key, parsed.data);
        return parsed.data;
      };
      const validatePaidStart = (
        params: SuperRareGameStartParams & { idempotencyKey: string },
      ): SuperRareGameStartParams & { idempotencyKey: string } => {
        if (!gameIdempotencyKeySchema.safeParse(params.idempotencyKey).success) {
          throw new Error('Game idempotencyKey must contain 8 to 128 URL-safe characters.');
        }
        return params;
      };
      const sessionBody = (params: SuperRareGameStartParams): Record<string, unknown> => ({
        ...(params.clientSessionId === undefined ? {} : { clientSessionId: params.clientSessionId }),
        ...(params.clientBuildId === undefined ? {} : { clientBuildId: params.clientBuildId }),
        ...(params.metadata === undefined ? {} : { metadata: params.metadata }),
      });
      const submitPaidStart = async (
        start: SuperRareGameStartParams & { idempotencyKey: string },
        consent: GamePaidConsent,
      ): Promise<GameSessionStart> => {
        if (groupPath === undefined || groupId === undefined) {
          throw new Error('A groupId is required for a paid game start.');
        }
        if (consent.appId !== appId || consent.groupId !== groupId) {
          throw new Error('The paid consent is bound to a different game or credit group.');
        }
        const result = parseGameSessionStart(await requestStudioJson({
          studioUrl: requireStudioUrl(), fetch: options.fetch,
          path: `${groupPath}/apps/${encodeURIComponent(appId)}/uses`, method: 'POST',
          authorization: `GameConsent ${consent.consentToken}`,
          idempotencyKey: start.idempotencyKey,
          body: { ...sessionBody(start), idempotencyKey: start.idempotencyKey },
        }));
        gameAttempts.delete(pendingConsentKey(start.idempotencyKey));
        try { storage?.removeItem(pendingConsentKey(start.idempotencyKey)); } catch { /* Caller still owns the stable key. */ }
        return result;
      };
      const startWithConsent = async (
        params: SuperRareGameStartParams & { idempotencyKey: string; consent: GamePaidConsent },
      ): Promise<GameSessionStart> => {
        const start = validatePaidStart(params);
        const attempt = readAttempt(start.idempotencyKey);
        if (attempt !== undefined && (JSON.stringify(sessionBody(start)) !== JSON.stringify(sessionBody(attempt.request))
          || attempt.consent?.consentToken !== params.consent.consentToken)) {
          throw new GameConnectionError('attempt_mismatch');
        }
        return await submitPaidStart(start, params.consent);
      };
      const connect = async (): Promise<GameAuthorization> => {
        const existing = currentAuthorization();
        if (existing !== undefined) return { ...existing };
        const connectionKey = scopeKey();
        const generation = sessionLifecycle.getReplacementGeneration();
        const inFlight = gameConnections.get(connectionKey);
        if (inFlight !== undefined) {
          if (inFlight.generation === generation) return inFlight.promise;
          gameConnections.delete(connectionKey);
        }
        if (groupId === undefined) throw new Error('Game connection requires groupId.');
        if (messageEvents === undefined) throw new Error('Game connection requires browser message events.');
        const appOrigin = requireAppOrigin();
        const state = createConnectState();
        const authorizationUrl = buildGameAuthorizationUrl({ studioUrl: requireStudioUrl(), appId, groupId, appOrigin, state });
        const popup = openPopupWindow(`superrare-connect-game-${createConnectPopupName()}`, authorizationUrl);
        if (popup === null) throw new ConnectPopupBlockedError();
        const connection = new Promise<GameAuthorization>((resolve, reject) => {
          let settled = false;
          let unsubscribe = (): void => {};
          const finish = (operation: () => void): void => {
            if (settled) return;
            settled = true;
            try { unsubscribe(); } catch { /* Cleanup must not prevent settlement. */ }
            try { if (!isPopupClosed(popup)) popup.close(); } catch { /* Already gone. */ }
            operation();
          };
          unsubscribe = messageEvents.subscribe((event) => {
            const parsed = parseGameAuthorizationMessage({
              data: event.data, origin: event.origin, expectedOrigin: requireStudioUrl(), expectedState: state,
              appId, groupId, appOrigin, now: Date.now(),
            });
            if (parsed.status === 'ignored') return;
            if (event.source === undefined) {
              finish(() => reject(new GameConnectionError('invalid_message')));
              return;
            }
            if (event.source !== popup) return;
            if (parsed.status === 'cancelled' || parsed.status === 'expired' || parsed.status === 'invalid_message') {
              finish(() => reject(new GameConnectionError(parsed.status)));
              return;
            }
            if (generation !== sessionLifecycle.getReplacementGeneration()) {
              finish(() => reject(new GameConnectionError('authorization_required')));
              return;
            }
            const authorized = parsed.authorization;
            gameAuthorizations.set(connectionKey, { ...authorized });
            try { storage?.setItem(authorizationStorageKey(), JSON.stringify(authorized)); } catch { /* Connection remains usable in memory. */ }
            finish(() => resolve({ ...authorized }));
          });
          if (settled) {
            try { unsubscribe(); } catch { /* Synchronous emitters may settle during subscription. */ }
          }
          const deadline = Date.now() + 5 * 60_000;
          const watch = async (): Promise<void> => {
            try {
              while (!settled) {
                await sleep(POPUP_POLL_INTERVAL_MS);
                if (settled) return;
                if (isPopupClosed(popup)) {
                  finish(() => reject(new GameConnectionError('cancelled')));
                  return;
                }
                if (Date.now() >= deadline) {
                  finish(() => reject(new GameConnectionError('expired')));
                  return;
                }
              }
            } catch (error) { finish(() => reject(error)); }
          };
          void watch();
        });
        const tracked = connection.finally(() => {
          if (gameConnections.get(connectionKey)?.promise === tracked) {
            gameConnections.delete(connectionKey);
          }
        });
        gameConnections.set(connectionKey, { generation, promise: tracked });
        return tracked;
      };
      const requestConsent = async (
        params: GameConsentRequest,
      ): Promise<{ consent: GamePaidConsent; recovery: 'persistent' | 'memory' }> => {
        // Snapshot JSON values before I/O so mutations cannot change a retried attempt.
        const snapshot: unknown = JSON.parse(JSON.stringify(params));
        const confirmed = gameConsentRequestSchema.parse(snapshot);
        const serialized = JSON.stringify(confirmed);
        const previous = readAttempt(confirmed.idempotencyKey);
        if (previous !== undefined && JSON.stringify(previous.request) !== serialized) {
          throw new GameConnectionError('attempt_mismatch');
        }
        const authorization = currentAuthorization();
        if (authorization === undefined) throw new GameConnectionError('authorization_required');
        if (authorization.appOrigin !== requireAppOrigin()) throw new GameConnectionError('invalid_origin');
        saveAttempt(previous ?? { request: confirmed });
        let value: unknown;
        try {
          value = await requestStudioJson({
            studioUrl: requireStudioUrl(), fetch: options.fetch, path: `${paidPath()}/consents`, method: 'POST',
            authorization: `GameAuthorization ${authorization.authorizationToken}`,
            body: { idempotencyKey: confirmed.idempotencyKey, fingerprint: confirmed.fingerprint, expectedCredits: confirmed.expectedCredits },
          });
        } catch (error) {
          if (error instanceof SuperRareConnectApiError && error.status === 401
            && gameAuthorizations.get(scopeKey())?.authorizationToken === authorization.authorizationToken) {
            clearAuthorization(authorization);
          }
          throw error;
        }
        const parsed = inlineConsentResponseSchema.parse(value).consent;
        if (parsed.appId !== appId || parsed.groupId !== groupId || parsed.credits !== confirmed.expectedCredits) {
          throw new GameConnectionError('attempt_mismatch');
        }
        const consent: GamePaidConsent = {
          appId: parsed.appId, groupId: parsed.groupId, consentId: parsed.id,
          consentToken: parsed.consentToken, expiresAt: parsed.expiresAt, credits: parsed.credits,
        };
        const recovery = saveAttempt({ request: confirmed, consent });
        return { consent: { ...consent }, recovery };
      };
      const requestCreditJson = async (input: {
        path: string; method?: 'GET' | 'POST'; body?: unknown;
      }): Promise<unknown> => {
        const path = `${paidPath()}${input.path}`;
        const authorization = currentAuthorization();
        if (authorization === undefined) throw new GameConnectionError('authorization_required');
        if (authorization.appOrigin !== requireAppOrigin()) throw new GameConnectionError('invalid_origin');
        try {
          return await requestStudioJson({
            ...input, studioUrl: requireStudioUrl(), fetch: options.fetch, path,
            authorization: `GameAuthorization ${authorization.authorizationToken}`,
          });
        } catch (error) {
          if (error instanceof SuperRareConnectApiError && error.status === 401) {
            clearAuthorization(authorization);
          }
          throw error;
        }
      };
      return {
        getAuthorization: () => {
          const authorization = currentAuthorization();
          return authorization === undefined ? undefined : { ...authorization };
        },
        async start(params = {}): Promise<GameSessionStart> {
          if (groupId !== undefined) throw new Error('Credit-gated games require inline consent and startWithConsent.');
          if (params.idempotencyKey !== undefined && !gameIdempotencyKeySchema.safeParse(params.idempotencyKey).success) {
            throw new Error('Game idempotencyKey must contain 8 to 128 URL-safe characters.');
          }
          return parseGameSessionStart(await requestStudioJson({
            studioUrl: requireStudioUrl(), fetch: options.fetch,
            path: `${gamePath}/sessions`, method: 'POST',
            ...(params.idempotencyKey === undefined ? {} : { idempotencyKey: params.idempotencyKey }),
            body: {
              ...sessionBody(params),
              ...(params.idempotencyKey === undefined ? {} : { idempotencyKey: params.idempotencyKey }),
            },
          }));
        },
        connect,
        async getTerms(): Promise<GameCreditTerms> {
          const appOrigin = requireAppOrigin();
          const terms = gameTermsResponseSchema.parse(await requestStudioJson({
            studioUrl: requireStudioUrl(), fetch: options.fetch, path: `${paidPath()}/terms`,
          })).terms;
          if (terms.appId !== appId || terms.groupId !== groupId || terms.appOrigin !== appOrigin) {
            throw new GameConnectionError('invalid_origin');
          }
          return terms;
        },
        requestConsent,
        startWithConsent,
        async recoverStart(params): Promise<GameSessionStart> {
          validatePaidStart(params);
          const attempt = readAttempt(params.idempotencyKey);
          if (attempt === undefined) throw new Error('No recoverable paid game start was found.');
          const suppliedBody = sessionBody(params);
          if (Object.keys(suppliedBody).length > 0 && JSON.stringify(suppliedBody) !== JSON.stringify(sessionBody(attempt.request))) {
            throw new GameConnectionError('attempt_mismatch');
          }
          const consent = attempt.consent ?? (await requestConsent(attempt.request)).consent;
          return await startWithConsent({ ...attempt.request, consent });
        },
        async complete(params): Promise<{ completed: true; idempotentReplay: boolean }> {
          const value = await requestStudioJson({ studioUrl: requireStudioUrl(), fetch: options.fetch,
            path: `${gamePath}/sessions/${encodeURIComponent(params.sessionId)}/complete`, method: 'POST',
            authorization: `PlaySession ${params.sessionToken}`, body: {}, });
          return z.object({ completed: z.literal(true), idempotentReplay: z.boolean() }).parse(value);
        },
        async submitClientAssertedScore(params): Promise<ClientAssertedScoreResult> {
          const board = params.leaderboardKey ?? 'default';
          return parseClientScore(await requestStudioJson({ studioUrl: requireStudioUrl(), fetch: options.fetch,
            path: `${gamePath}/leaderboards/${encodeURIComponent(board)}/scores`, method: 'POST',
            authorization: `PlaySession ${params.sessionToken}`, idempotencyKey: params.idempotencyKey,
            body: { score: params.score, seasonKey: params.seasonKey, secondaryValue: params.secondaryValue,
              metadata: params.metadata, idempotencyKey: params.idempotencyKey }, }));
        },
        async startServerValidatedRun(params): Promise<ServerValidatedGameRun> {
          return parseServerRun(await requestStudioJson({ studioUrl: requireStudioUrl(), fetch: options.fetch,
            path: `${gamePath}/scoring/events/${encodeURIComponent(params.eventId)}/runs`, method: 'POST',
            authorization: `PlaySession ${params.sessionToken}`, body: { idempotencyKey: params.idempotencyKey }, }));
        },
        async getLeaderboard(params = {}): Promise<GameLeaderboard> {
          const query = new URLSearchParams();
          if (params.seasonKey !== undefined) query.set('season', params.seasonKey);
          if (params.limit !== undefined) query.set('limit', String(params.limit));
          if (params.cursor !== undefined) query.set('cursor', params.cursor);
          const suffix = query.size === 0 ? '' : `?${query.toString()}`;
          return parseLeaderboard(await requestStudioJson({ studioUrl: requireStudioUrl(), fetch: options.fetch,
            path: `${gamePath}/leaderboards/${encodeURIComponent(params.leaderboardKey ?? 'default')}/entries${suffix}`, }));
        },
        async getMyBest(params): Promise<GameLeaderboardEntry | null> {
          const query = params.seasonKey === undefined ? '' : `?season=${encodeURIComponent(params.seasonKey)}`;
          return parseMyBest(await requestStudioJson({ studioUrl: requireStudioUrl(), fetch: options.fetch,
            path: `${gamePath}/leaderboards/${encodeURIComponent(params.leaderboardKey ?? 'default')}/me${query}`,
            authorization: `PlaySession ${params.sessionToken}`, }));
        },
        credits: {
          async getBalance(): Promise<GameCreditBalance> {
            return parseCreditBalance(await requestCreditJson({ path: '/me' }));
          },
          async createPurchase(): Promise<GameCreditPurchase> {
            return parsePurchase(await requestCreditJson({ path: '/purchases', method: 'POST' }));
          },
          async getPurchase(purchaseId): Promise<GameCreditPurchase> {
            return parsePurchase(await requestCreditJson({
              path: `/purchases/${encodeURIComponent(purchaseId)}`,
            }));
          },
          async claimPurchase(params): Promise<{ purchase: GameCreditPurchase; balance: GameCreditBalance }> {
            const value = await requestCreditJson({
              path: `/purchases/${encodeURIComponent(params.purchaseId)}/claim`, method: 'POST',
              body: { transactionHash: params.transactionHash },
            });
            return { purchase: parsePurchase(value), balance: parseCreditBalance(value) };
          },
        },
      };
    },
  };

  return {
    auth: {
      login,
      loginWithPopup: login,
      prepareLogin,
      getSession: sessionLifecycle.getSession,
      async getAccessToken(): Promise<string> {
        const session = await sessionLifecycle.getCurrentSession();
        if (session === undefined) throw new ConnectSessionRequiredError();
        return session.sessionId;
      },
      async getRemoteSession(): Promise<ConnectSessionState> {
        const session = await sessionLifecycle.getCurrentSession();
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
        inFlightPopupLogin = undefined;
        sessionLifecycle.clear();
      },
      async logout(): Promise<void> {
        sessionCommitGeneration += 1;
        inFlightPopupLogin = undefined;
        await sessionLifecycle.logout();
      },
      onChange(callback): () => void {
        return sessionLifecycle.onChange(callback);
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
      async sell(params): Promise<ConnectIntentCreation> {
        return await startIntent(buildConnectSellIntentRequest({
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
      async transfer(params): Promise<ConnectIntentCreation> {
        return await startIntent(buildConnectTransferIntentRequest({
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
    games,
  };
}

function resolveConnectSessionStorage(
  storage: ConnectSessionStorage | false | undefined,
): ConnectSessionStorage | undefined {
  if (storage === false) return undefined;
  return storage ?? readBrowserLocalStorage();
}

function readBrowserLocalStorage(): ConnectSessionStorage | undefined {
  // Reading globalThis.localStorage throws (SecurityError) when storage is
  // blocked — a sandboxed or third-party iframe, or Safari "block all cookies".
  // Degrade to no persistence instead of aborting client construction, which
  // with eager init would blank the whole embedding app.
  try {
    const storage = Reflect.get(globalThis, 'localStorage');
    return isConnectSessionStorage(storage) ? storage : undefined;
  } catch {
    return undefined;
  }
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

type ResolvedLoginParams = {
  returnPath: string | undefined;
  initiatingOrigin: string | undefined;
};

type PreparedLogin = {
  started: StartedLoginIntent;
  connectOrigin: string;
  popupUrl: string;
  params: ResolvedLoginParams;
  operationGeneration: number;
};

/**
 * How much of the intent's life a prepared login must still have to be worth
 * opening: a window opened on an intent about to expire would only show the
 * hosted page's "expired" screen.
 */
const PREPARED_LOGIN_MIN_REMAINING_MS = 60_000;

/**
 * Whether a prepared login can serve a `login` call: same return path and
 * initiating origin, and enough of its intent's life left. An expiry that
 * cannot be parsed is treated as expired.
 */
function isPreparedLoginUsable(input: {
  prepared: PreparedLogin;
  params: ResolvedLoginParams;
  now: number;
}): boolean {
  if (
    input.prepared.params.returnPath !== input.params.returnPath ||
    input.prepared.params.initiatingOrigin !== input.params.initiatingOrigin
  ) {
    return false;
  }

  const expiresAt = Date.parse(input.prepared.started.intent.expiresAt);
  if (Number.isNaN(expiresAt)) return false;

  return expiresAt - input.now > PREPARED_LOGIN_MIN_REMAINING_MS;
}

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
          listener({ origin: event.origin, data: event.data, source: event.source });
        }
      };
      addEventListener.call(globalThis, 'message', domListener);
      return () => {
        removeEventListener.call(globalThis, 'message', domListener);
      };
    },
  };
}

function readBrowserVisibilityEvents(): ConnectPopupVisibilityEvents | undefined {
  const document: unknown = Reflect.get(globalThis, 'document');
  if (
    typeof document !== 'object' ||
    document === null ||
    !('addEventListener' in document) ||
    !('removeEventListener' in document) ||
    typeof document.addEventListener !== 'function' ||
    typeof document.removeEventListener !== 'function'
  ) {
    return undefined;
  }
  const addEventListener = document.addEventListener;
  const removeEventListener = document.removeEventListener;

  return {
    subscribe(listener) {
      const domListener = (): void => {
        listener(Reflect.get(document, 'visibilityState') === 'visible');
      };
      addEventListener.call(document, 'visibilitychange', domListener);
      return () => {
        removeEventListener.call(document, 'visibilitychange', domListener);
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
