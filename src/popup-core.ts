import type { ConnectIntentStatus } from './status-core.js';

/**
 * The window every hosted Connect flow runs in: the hosted URL opens in a
 * small centered window (the pattern used by Google sign-in and wallet
 * providers) while the integrator's page stays put.
 */

export const DEFAULT_CONNECT_POPUP_WIDTH = 480;
export const DEFAULT_CONNECT_POPUP_HEIGHT = 720;

/** Structural view of the opened window; lets tests stub `window.open`. */
export type ConnectPopupWindow = {
  closed: boolean;
  close: () => void;
  location: { replace: (url: string) => void };
};

export type ConnectPopupOpener = (
  url: string,
  target: string,
  features: string,
) => ConnectPopupWindow | null;

export type ConnectPopupSize = {
  width?: number;
  height?: number;
};

/**
 * Window features for a centered popup. Screen dimensions are optional; when
 * missing the browser places the window itself.
 */
export const getConnectPopupFeatures = (input: {
  size: ConnectPopupSize | undefined;
  screenWidth: number | undefined;
  screenHeight: number | undefined;
}): string => {
  const width = input.size?.width ?? DEFAULT_CONNECT_POPUP_WIDTH;
  const height = input.size?.height ?? DEFAULT_CONNECT_POPUP_HEIGHT;
  const features = [`popup=yes`, `width=${width}`, `height=${height}`];
  if (input.screenWidth !== undefined && input.screenHeight !== undefined) {
    const left = Math.max(0, Math.round((input.screenWidth - width) / 2));
    const top = Math.max(0, Math.round((input.screenHeight - height) / 2));
    features.push(`left=${left}`, `top=${top}`);
  }

  return features.join(',');
};

const settledStatuses: ReadonlySet<ConnectIntentStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  'expired',
]);

/** Terminal intent statuses — the popup can be closed once one is reached. */
export const isConnectIntentSettled = (status: ConnectIntentStatus): boolean =>
  settledStatuses.has(status);

/**
 * Deadline for a popup watcher, in epoch milliseconds. An expiry that cannot be
 * parsed — or that is already in the past, which means the client clock is
 * skewed rather than the intent being dead — falls back to `now + fallbackMs`,
 * so a watcher always has a deterministic end.
 */
export function getConnectPopupDeadline(input: {
  expiresAt: string;
  now: number;
  fallbackMilliseconds: number;
}): number {
  const deadline = Date.parse(input.expiresAt);
  if (Number.isNaN(deadline) || deadline <= input.now) {
    return input.now + input.fallbackMilliseconds;
  }

  return deadline;
}

/**
 * Whether a failed status poll is worth retrying. A 4xx means the intent is
 * gone, expired or forbidden and will not become readable by asking again;
 * timeouts and rate limits are the exceptions that do resolve on their own.
 */
export function isRetryableConnectApiStatus(status: number): boolean {
  if (status === 408 || status === 429) {
    return true;
  }

  return status < 400 || status >= 500;
}
