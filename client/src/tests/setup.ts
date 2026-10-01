import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * Client test setup: jest-dom matchers and DOM teardown.
 *
 * The API module is mocked per test file (see `harness.ts`) because the state
 * has to be owned by the same file that reads it; keeping it here instead let
 * the mocked session silently fall back to its default.
 */
afterEach(() => {
  cleanup();
});
