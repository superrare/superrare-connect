import { describe, expect, it } from 'vitest';
import {
  buildConnectLaunchUrl,
  parseConnectLaunchReportMessage,
} from '../src/launch-core.js';

const request = {
  action: { type: 'login' as const },
  returnPath: '/',
  state: 'state_123',
  initiatingOrigin: 'https://artist.example',
};

describe('buildConnectLaunchUrl', () => {
  it('builds a fragment-carrying launch URL on the connect origin', () => {
    const result = buildConnectLaunchUrl({
      connectUrl: 'https://connect.staging.test',
      launchId: 'launch_1',
      request,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.origin).toBe('https://connect.staging.test');
    expect(result.url.startsWith('https://connect.staging.test/launch#')).toBe(true);

    // The payload round-trips: the launch page must recover the exact
    // request, launch id, and version.
    const fragment = result.url.split('#')[1] ?? '';
    expect(JSON.parse(decodeURIComponent(fragment))).toEqual({
      launchId: 'launch_1',
      request,
      v: 1,
    });
  });

  it('defaults to the production connect origin', () => {
    const result = buildConnectLaunchUrl({
      connectUrl: undefined,
      launchId: 'launch_1',
      request,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.origin).toBe('https://connect.superrare.com');
  });

  it('allows loopback http for local development and refuses other http', () => {
    expect(
      buildConnectLaunchUrl({
        connectUrl: 'http://localhost:5002',
        launchId: 'launch_1',
        request,
      }).ok,
    ).toBe(true);

    expect(
      buildConnectLaunchUrl({
        connectUrl: 'http://connect.example',
        launchId: 'launch_1',
        request,
      }),
    ).toEqual({ ok: false, error: 'invalid_connect_url' });
  });
});

describe('parseConnectLaunchReportMessage', () => {
  const createdMessage = {
    type: 'superrare-connect:launch-created',
    launchId: 'launch_1',
    intentId: 'connect_intent_1',
    url: 'https://connect.staging.test/action/connect_intent_1',
    expiresAt: '2027-01-01T00:00:00.000Z',
  };

  it('accepts a created report from the connect origin for this launch', () => {
    expect(
      parseConnectLaunchReportMessage({
        data: createdMessage,
        origin: 'https://connect.staging.test',
        expectedOrigin: 'https://connect.staging.test',
        launchId: 'launch_1',
      }),
    ).toEqual({
      ok: true,
      report: {
        status: 'created',
        intentId: 'connect_intent_1',
        url: 'https://connect.staging.test/action/connect_intent_1',
        expiresAt: '2027-01-01T00:00:00.000Z',
      },
    });
  });

  it('accepts a failed report', () => {
    expect(
      parseConnectLaunchReportMessage({
        data: {
          type: 'superrare-connect:launch-failed',
          launchId: 'launch_1',
          message: 'Unsupported chain.',
        },
        origin: 'https://connect.staging.test',
        expectedOrigin: 'https://connect.staging.test',
        launchId: 'launch_1',
      }),
    ).toEqual({
      ok: true,
      report: { status: 'failed', message: 'Unsupported chain.' },
    });
  });

  it('rejects a report from a foreign origin', () => {
    expect(
      parseConnectLaunchReportMessage({
        data: createdMessage,
        origin: 'https://evil.test',
        expectedOrigin: 'https://connect.staging.test',
        launchId: 'launch_1',
      }),
    ).toEqual({ ok: false, error: 'origin_mismatch' });
  });

  it('treats a report for another launch as unrelated', () => {
    // A concurrent flow on the same page owns that report; this listener
    // must keep waiting rather than claim or reject it.
    expect(
      parseConnectLaunchReportMessage({
        data: { ...createdMessage, launchId: 'launch_other' },
        origin: 'https://connect.staging.test',
        expectedOrigin: 'https://connect.staging.test',
        launchId: 'launch_1',
      }),
    ).toEqual({ ok: false, error: 'not_launch_report' });
  });

  it('ignores unrelated messages and flags malformed reports distinctly', () => {
    expect(
      parseConnectLaunchReportMessage({
        data: { type: 'other' },
        origin: 'https://connect.staging.test',
        expectedOrigin: 'https://connect.staging.test',
        launchId: 'launch_1',
      }),
    ).toEqual({ ok: false, error: 'not_launch_report' });

    expect(
      parseConnectLaunchReportMessage({
        data: { type: 'superrare-connect:launch-created', launchId: 'launch_1' },
        origin: 'https://connect.staging.test',
        expectedOrigin: 'https://connect.staging.test',
        launchId: 'launch_1',
      }),
    ).toEqual({ ok: false, error: 'malformed_message' });
  });
});
