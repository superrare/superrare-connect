export type ConnectSessionView = {
  state: 'checking' | 'verification_failed' | 'authenticated' | 'expired' | 'signed_out';
  action: 'none' | 'check' | 'login';
  disabled: boolean;
  buttonLabel: string;
  status: string;
};

export type HostedDisplayResult =
  | { ok: true; display: 'embed' | 'popup' }
  | { ok: false; reason: 'invalid_display' | 'invalid_connect_url' | 'production_embed_blocked' | 'display_required' };

export type GameAuthorizationView = {
  state: 'authorization_not_confirmed' | 'authorization_confirmed_refresh_failed' | 'authorization_confirmed';
  buttonLabel: string;
  status: string;
};

export function deriveConnectSessionView(
  state: ConnectSessionView['state'],
  session: { expiresAt?: string } | undefined,
  now?: number,
): ConnectSessionView;
export function resolveHostedDisplay(display: string | null, connectUrl: string): HostedDisplayResult;
export function deriveGameAuthorizationView(
  authorization: { appId: string; groupId: string } | undefined,
  refreshFailed: boolean,
): GameAuthorizationView;
export function describeSdkFailure(error: unknown): string;
export function createHostedConnectSurface(input: {
  dialog: HTMLDialogElement;
  frameRoot: HTMLElement;
  status: HTMLElement;
}): {
  open: (url: string, target: string) => {
    readonly closed: boolean;
    messageSource: MessageEventSource | null;
    close: () => void;
    location: { replace: (url: string) => void };
  } | null;
  messageEvents: {
    subscribe: (listener: (event: { origin: string; source: MessageEventSource | null; data: unknown }) => void) => () => void;
  };
  onUnavailable: (error: unknown) => void;
  close: () => void;
};
