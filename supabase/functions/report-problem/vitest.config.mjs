import { fileURLToPath } from 'node:url';
// Reuse the repository's test dependency; do not install production packages in
// the Edge Function bundle just to execute its offline regression tests.
export default {
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: { alias: { vitest: fileURLToPath(new URL('../../../apps/mobile/node_modules/vitest/dist/index.js', import.meta.url)) } },
  test: { environment: 'node', include: ['core.test.ts'] },
};
