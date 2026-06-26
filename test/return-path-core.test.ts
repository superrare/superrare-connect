import { describe, expect, it } from 'vitest';
import { normalizeReturnPath } from '../src/return-path-core.js';

describe('normalizeReturnPath', () => {
  it.each([
    [undefined, '/'],
    ['/', '/'],
    ['/account', '/account'],
    ['/checkout/complete?listing=123', '/checkout/complete?listing=123'],
    ['/account#profile', '/account#profile'],
    [' /account ', '/account'],
  ] as const)('normalizes %s to %s', (returnPath, expected) => {
    expect(normalizeReturnPath(returnPath)).toEqual({
      ok: true,
      returnPath: expected,
    });
  });

  it.each([
    'https://evil.example/account',
    'http://evil.example/account',
    '//evil.example/account',
    '/\\evil.example',
    '/%2f%2fevil.example',
    '/%5cevil.example',
    '/account\u0000',
    'javascript:alert(1)',
    'account',
    '',
    '   ',
  ])('rejects unsafe returnPath %s', (returnPath) => {
    expect(normalizeReturnPath(returnPath)).toEqual({
      ok: false,
      error: 'invalid_return_path',
    });
  });
});
