import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // `server-only` throws outside React Server Components; tests import server modules directly.
      'server-only': fileURLToPath(new URL('./test/server-only-stub.ts', import.meta.url)),
    },
  },
  // tsconfig keeps JSX for Next ("preserve"); tests render the PDF templates themselves.
  esbuild: { jsx: 'automatic' },
  test: { include: ['test/**/*.test.ts'] },
});
