import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          ENCRYPTION_KEY: 'test-encryption-key-0123456789abcdef',
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
  },
});
