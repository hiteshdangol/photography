import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/tests/**/*.test.ts'],
    setupFiles: ['src/tests/setup.ts'],
    // Sharp + memory MongoDB are slow to boot; give suites room to breathe.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Each test file gets its own memory-server instance; run them serially to
    // avoid exhausting memory on developer laptops.
    fileParallelism: false,
    pool: 'forks',
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/scripts/**', 'src/index.ts', 'src/worker.ts', 'src/tests/**'],
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
