import { defineConfig } from 'vitest/config';

// Pure unit tests run under Node. Real Durable Object behavior is exercised by
// local-oauth-e2e.mjs against wrangler dev, not by an incompatible Vitest pool.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
