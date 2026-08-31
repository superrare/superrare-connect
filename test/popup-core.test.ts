import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONNECT_POPUP_HEIGHT,
  DEFAULT_CONNECT_POPUP_WIDTH,
  getConnectPopupDeadline,
  getConnectPopupFeatures,
  isConnectIntentSettled,
  isRetryableConnectApiStatus,
} from '../src/popup-core.js';

describe('getConnectPopupFeatures', () => {
  it('centers the popup on the available screen', () => {
    const features = getConnectPopupFeatures({
      size: { width: 400, height: 600 },
      screenWidth: 1440,
      screenHeight: 900,
    });

    expect(features).toBe('popup=yes,width=400,height=600,left=520,top=150');
  });

  it('falls back to the default size', () => {
    const features = getConnectPopupFeatures({
      size: undefined,
      screenWidth: undefined,
      screenHeight: undefined,
    });

    expect(features).toBe(
      `popup=yes,width=${DEFAULT_CONNECT_POPUP_WIDTH},height=${DEFAULT_CONNECT_POPUP_HEIGHT}`,
    );
  });

  it('never positions the popup off-screen on small displays', () => {
    const features = getConnectPopupFeatures({
      size: { width: 480, height: 720 },
      screenWidth: 360,
      screenHeight: 640,
    });

    expect(features).toContain('left=0');
    expect(features).toContain('top=0');
  });
});

describe('isConnectIntentSettled', () => {
  it('treats only terminal statuses as settled', () => {
    expect(isConnectIntentSettled('completed')).toBe(true);
    expect(isConnectIntentSettled('failed')).toBe(true);
    expect(isConnectIntentSettled('cancelled')).toBe(true);
    expect(isConnectIntentSettled('expired')).toBe(true);
    // The popup stays open while the buyer still has work to do.
    expect(isConnectIntentSettled('pending')).toBe(false);
    expect(isConnectIntentSettled('requires_user')).toBe(false);
    expect(isConnectIntentSettled('processing')).toBe(false);
  });
});

describe('getConnectPopupDeadline', () => {
  it('parses a future ISO expiry into epoch milliseconds', () => {
    expect(getConnectPopupDeadline({
      expiresAt: '2027-01-01T00:00:00.000Z',
      now: 1_000,
      fallbackMilliseconds: 60_000,
    })).toBe(Date.parse('2027-01-01T00:00:00.000Z'));
  });

  it('falls back to now plus the fallback window for an unparseable expiry', () => {
    expect(getConnectPopupDeadline({
      expiresAt: 'not-a-date',
      now: 1_000,
      fallbackMilliseconds: 60_000,
    })).toBe(61_000);
  });

  it('treats an already-past expiry as clock skew and uses the fallback window', () => {
    // A fresh intent whose expiry is behind the client clock means the client
    // is running ahead; using the parsed deadline would expire a valid login.
    expect(getConnectPopupDeadline({
      expiresAt: '2020-01-01T00:00:00.000Z',
      now: Date.parse('2026-01-01T00:00:00.000Z'),
      fallbackMilliseconds: 60_000,
    })).toBe(Date.parse('2026-01-01T00:00:00.000Z') + 60_000);
  });
});

describe('isRetryableConnectApiStatus', () => {
  it('retries transport and server failures', () => {
    for (const status of [0, 500, 502, 503, 504]) {
      expect(isRetryableConnectApiStatus(status)).toBe(true);
    }
  });

  it('gives up on a client error the intent will not recover from', () => {
    for (const status of [400, 401, 403, 404, 410]) {
      expect(isRetryableConnectApiStatus(status)).toBe(false);
    }
  });

  it('still retries timeouts and rate limits', () => {
    expect(isRetryableConnectApiStatus(408)).toBe(true);
    expect(isRetryableConnectApiStatus(429)).toBe(true);
  });
});
