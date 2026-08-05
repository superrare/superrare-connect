import type { ConnectIntentStatus } from './status-core.js';

/**
 * Popup display for hosted Connect flows: instead of redirecting the whole
 * page, the hosted URL opens in a small centered window (the pattern used by
 * Google sign-in and wallet providers) while the integrator's page stays put.
 */

export const DEFAULT_CONNECT_POPUP_WIDTH = 480;
export const DEFAULT_CONNECT_POPUP_HEIGHT = 720;

/** Search param the hosted app reads to adapt its chrome to the popup. */
const CONNECT_POPUP_DISPLAY_PARAM = 'display';
const CONNECT_POPUP_DISPLAY_VALUE = 'popup';

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

/** Appends `display=popup` so the hosted app renders popup-aware chrome. */
export const appendConnectPopupDisplay = (url: string): string => {
  const target = new URL(url);
  target.searchParams.set(CONNECT_POPUP_DISPLAY_PARAM, CONNECT_POPUP_DISPLAY_VALUE);
  return target.toString();
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
