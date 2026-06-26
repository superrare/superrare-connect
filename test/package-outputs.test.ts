import { readFile, stat } from 'node:fs/promises';
import vm from 'node:vm';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

const packageJsonSchema = z.object({
  main: z.string(),
  module: z.string(),
  browser: z.string(),
  types: z.string(),
  exports: z.object({
    '.': z.object({
      types: z.string(),
      import: z.string(),
      require: z.string(),
    }),
    './global': z.string(),
  }),
});

type BrowserBundleContext = {
  SuperRareConnect?: unknown;
};

describe('package outputs', () => {
  it.each([
    './dist/index.js',
    './dist/index.cjs',
    './dist/index.d.ts',
    './dist/superrare-connect.global.js',
  ])('builds %s', async (filePath) => {
    const file = await stat(filePath);

    expect(file.isFile()).toBe(true);
    expect(file.size).toBeGreaterThan(0);
  });

  it('keeps package exports aligned with built files', async () => {
    const packageJson = packageJsonSchema.parse(parseJson(await readFile('package.json', 'utf8')));

    expect(packageJson.main).toBe('./dist/index.cjs');
    expect(packageJson.module).toBe('./dist/index.js');
    expect(packageJson.browser).toBe('./dist/superrare-connect.global.js');
    expect(packageJson.types).toBe('./dist/index.d.ts');
    expect(packageJson.exports['.']).toEqual({
      types: './dist/index.d.ts',
      import: './dist/index.js',
      require: './dist/index.cjs',
    });
    expect(packageJson.exports['./global']).toBe('./dist/superrare-connect.global.js');
  });

  it('exposes the documented browser global API', async () => {
    const source = await readFile('./dist/superrare-connect.global.js', 'utf8');
    const context: BrowserBundleContext = {};

    vm.createContext(context);
    new vm.Script(source).runInContext(context);

    expect(hasDocumentedBrowserGlobal(context.SuperRareConnect)).toBe(true);
  });
});

function parseJson(value: string): unknown {
  const parsed: unknown = JSON.parse(value);
  return parsed;
}

function hasDocumentedBrowserGlobal(value: unknown): value is {
  createSuperRareClient: (...args: never[]) => unknown;
  normalizeReturnPath: (...args: never[]) => unknown;
  resolveConnectIntentOutcome: (...args: never[]) => unknown;
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'createSuperRareClient' in value &&
    'normalizeReturnPath' in value &&
    'resolveConnectIntentOutcome' in value &&
    typeof value.createSuperRareClient === 'function' &&
    typeof value.normalizeReturnPath === 'function' &&
    typeof value.resolveConnectIntentOutcome === 'function'
  );
}
