import { z } from 'zod';
import { resolveConnectHostedUrl } from './popup-login-core.js';
import type { CreateConnectIntentRequest } from './auth-flow-core.js';

/**
 * The launch handoff: the SDK opens the hosted window straight at
 * `<connect>/launch#<payload>` inside the user's gesture, and that page —
 * always the foreground tab — creates the intent itself, reports it back to
 * the opener with a `postMessage`, and navigates itself into the hosted
 * flow. iOS Safari suspends the opener tab the moment the new window takes
 * focus, so nothing between the tap and the hosted flow may depend on the
 * opener staying awake — which rules out creating the intent from here.
 */

export const DEFAULT_CONNECT_URL = 'https://connect.superrare.com';

export const CONNECT_LAUNCH_CREATED_MESSAGE_TYPE = 'superrare-connect:launch-created';
export const CONNECT_LAUNCH_FAILED_MESSAGE_TYPE = 'superrare-connect:launch-failed';

export type ConnectLaunchUrlResult =
  | { ok: true; origin: string; url: string }
  | { ok: false; error: 'invalid_connect_url' };

/**
 * Builds the URL the window opens at. The payload rides in the fragment so
 * it never reaches a server, and the connect URL passes the same
 * https-or-loopback guard every hosted navigation crosses — it is about to
 * become a real navigation target AND the only origin whose launch reports
 * are trusted.
 */
export function buildConnectLaunchUrl(input: {
  connectUrl: string | undefined;
  launchId: string;
  request: CreateConnectIntentRequest;
}): ConnectLaunchUrlResult {
  const connectUrl = input.connectUrl === undefined || input.connectUrl.trim().length === 0
    ? DEFAULT_CONNECT_URL
    : input.connectUrl;
  const hostedUrl = resolveConnectHostedUrl(connectUrl);
  if (!hostedUrl.ok) {
    return { ok: false, error: 'invalid_connect_url' };
  }

  const payload = JSON.stringify({
    launchId: input.launchId,
    request: input.request,
    v: 1,
  });
  return {
    ok: true,
    origin: hostedUrl.origin,
    url: `${hostedUrl.origin}/launch#${encodeURIComponent(payload)}`,
  };
}

const connectLaunchCreatedMessageSchema = z.object({
  type: z.literal(CONNECT_LAUNCH_CREATED_MESSAGE_TYPE),
  launchId: z.string().min(1),
  intentId: z.string().min(1),
  url: z.string().min(1),
  expiresAt: z.string().min(1),
});

const connectLaunchFailedMessageSchema = z.object({
  type: z.literal(CONNECT_LAUNCH_FAILED_MESSAGE_TYPE),
  launchId: z.string().min(1),
  message: z.string(),
});

export type ConnectLaunchReport =
  | {
    status: 'created';
    intentId: string;
    url: string;
    expiresAt: string;
  }
  | {
    status: 'failed';
    message: string;
  };

export type ConnectLaunchReportParseResult =
  | { ok: true; report: ConnectLaunchReport }
  | { ok: false; error: 'not_launch_report' | 'origin_mismatch' | 'malformed_message' };

/**
 * Validates a `message` event candidate for the launch handoff. Unrelated
 * messages — and reports for a different launch, which belong to a
 * concurrent flow on the same page — resolve to `not_launch_report` so
 * callers keep waiting; only the trusted connect origin may speak for a
 * launch it hosts.
 */
export function parseConnectLaunchReportMessage(input: {
  data: unknown;
  origin: string;
  expectedOrigin: string;
  launchId: string;
}): ConnectLaunchReportParseResult {
  if (!isLaunchReportShaped(input.data)) {
    return { ok: false, error: 'not_launch_report' };
  }

  if (input.origin !== input.expectedOrigin) {
    return { ok: false, error: 'origin_mismatch' };
  }

  const created = connectLaunchCreatedMessageSchema.safeParse(input.data);
  if (created.success) {
    if (created.data.launchId !== input.launchId) {
      return { ok: false, error: 'not_launch_report' };
    }

    return {
      ok: true,
      report: {
        status: 'created',
        intentId: created.data.intentId,
        url: created.data.url,
        expiresAt: created.data.expiresAt,
      },
    };
  }

  const failed = connectLaunchFailedMessageSchema.safeParse(input.data);
  if (failed.success) {
    if (failed.data.launchId !== input.launchId) {
      return { ok: false, error: 'not_launch_report' };
    }

    return {
      ok: true,
      report: { status: 'failed', message: failed.data.message },
    };
  }

  return { ok: false, error: 'malformed_message' };
}

function isLaunchReportShaped(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    (data.type === CONNECT_LAUNCH_CREATED_MESSAGE_TYPE ||
      data.type === CONNECT_LAUNCH_FAILED_MESSAGE_TYPE)
  );
}
