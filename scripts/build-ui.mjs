import { build } from 'esbuild';

await build({
  entryPoints: ['src/ui/dashboard.tsx'],
  bundle: true,
  minify: true,
  sourcemap: true,
  outdir: 'dist/public',
  format: 'esm',
  target: ['es2022'],
  loader: { '.woff2': 'file', '.woff': 'file' },
});
