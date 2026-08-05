import { describe, expect, it } from 'vitest';
import {
  appendConnectPopupDisplay,
  getConnectPopupFeatures,
  isConnectIntentSettled,
  DEFAULT_CONNECT_POPUP_HEIGHT,
  DEFAULT_CONNECT_POPUP_WIDTH,
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

describe('appendConnectPopupDisplay', () => {
  it('marks the hosted URL as popup without dropping existing params', () => {
    expect(
      appendConnectPopupDisplay(
        'https://connect.superrare.test/action/connect_intent_1?executionSessionId=session_1',
      ),
    ).toBe(
      'https://connect.superrare.test/action/connect_intent_1?executionSessionId=session_1&display=popup',
    );
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
