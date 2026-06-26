import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    target: 'es2022',
    clean: true,
    dts: true,
    sourcemap: true,
    outExtension({ format }) {
      return {
        js: format === 'cjs' ? '.cjs' : '.js',
      };
    },
  },
  {
    entry: {
      'superrare-connect': 'src/index.ts',
    },
    format: ['iife'],
    target: 'es2022',
    platform: 'browser',
    globalName: 'SuperRareConnect',
    clean: false,
    dts: false,
    sourcemap: true,
    noExternal: ['zod'],
  },
]);
