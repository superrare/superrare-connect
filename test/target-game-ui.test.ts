import { describe, expect, it } from 'vitest';
import {
  describeSdkFailure,
  deriveConnectSessionView,
  deriveGameAuthorizationView,
  resolveHostedDisplay,
} from '../examples/target-game/hosted-flow.js';

describe('hosted Connect transport selection', () => {
  it('defaults only the known dev-mainnet host to embedding', () => {
    expect(resolveHostedDisplay(null, 'https://connect-dev-mainnet.superrare.co')).toEqual({
      ok: true,
      display: 'embed',
    });
  });

  it('requires an explicit popup on production Connect', () => {
    expect(resolveHostedDisplay(null, 'https://connect.superrare.com')).toMatchObject({
      ok: false,
      reason: 'production_embed_blocked',
    });
    expect(resolveHostedDisplay('popup', 'https://connect.superrare.com')).toEqual({
      ok: true,
      display: 'popup',
    });
  });

  it('requires a transport choice for unknown hosts', () => {
    expect(resolveHostedDisplay(null, 'https://connect.example')).toMatchObject({
      ok: false,
      reason: 'display_required',
    });
    expect(resolveHostedDisplay('embed', 'https://connect.example')).toEqual({
      ok: true,
      display: 'embed',
    });
  });
});

describe('target game Connect session view', () => {
  it('shows an existing unexpired session instead of another sign-in action', () => {
    expect(deriveConnectSessionView(
      'authenticated',
      { expiresAt: '2030-01-01T00:00:00.000Z' },
      Date.parse('2029-12-31T23:59:00.000Z'),
    )).toMatchObject({
      state: 'authenticated',
      action: 'none',
      disabled: true,
    });
  });

  it('requires a session check at expiry rather than treating it as signed out', () => {
    const view = deriveConnectSessionView(
      'authenticated',
      { expiresAt: '2030-01-01T00:00:00.000Z' },
      Date.parse('2030-01-01T00:00:00.000Z'),
    );

    expect(view.state).toBe('expired');
    expect(view.action).toBe('check');
  });

  it('offers verification retry without replacing preserved credentials with a login action', () => {
    const view = deriveConnectSessionView('verification_failed', { expiresAt: '2030-01-01T00:00:00.000Z' });

    expect(view.action).toBe('check');
    expect(view.disabled).toBe(false);
  });
});

describe('target game authorization result handling', () => {
  it('keeps confirmed authorization visible when a balance or round refresh fails', () => {
    const outcome = deriveGameAuthorizationView({ appId: 'app', groupId: 'group' }, true);

    expect(outcome.state).toBe('authorization_confirmed_refresh_failed');
    expect(deriveGameAuthorizationView(undefined, false).state).toBe('authorization_not_confirmed');
  });

  it('reports stable request diagnostics without exposing error messages or credentials', () => {
    const detail = describeSdkFailure({
      code: 'authorization_required',
      status: 403,
      path: '/api/v1/credit-groups/group/apps/app/authorizations',
      message: 'authorizationToken=secret-value',
    });

    expect(detail).toContain('authorization_required');
    expect(detail).toContain('HTTP 403');
    expect(detail).toContain('/api/v1/credit-groups/group/apps/app/authorizations');
    expect(detail).not.toContain('secret-value');
  });
});
