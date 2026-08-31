/**
 * The one-time parameters the hosted login page reports back to the SDK
 * (via `postMessage` to the opener): the intent they belong to, the CSRF
 * `state` the SDK created, and the single-use code the backend exchanges for
 * a Connect session.
 */
export type ConnectAuthCallbackParams = {
  intentId: string;
  state: string;
  code: string;
};
