import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts', 'src/cli.ts'],
    format: ['esm'],
    dts: true,
    sourcemap: false,
    clean: true,
    splitting: false,
  },
  {
    entry: { action: 'src/action.ts' },
    format: ['cjs'],
    platform: 'node',
    target: 'node20',
    outDir: 'dist/action',
    outExtension: () => ({ js: '.cjs' }),
    bundle: true,
    minify: false,
    sourcemap: false,
    noExternal: [/.*/],
  },
]);
