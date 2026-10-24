import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          ADMIN_PASSWORD: 'test-password',
          ENCRYPTION_KEY: 'test-encryption-key-0123456789abcdef',
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
  },
});
