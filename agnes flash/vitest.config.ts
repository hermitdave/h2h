import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    // Scale tests are opt-in (SCALE_TESTS=1) and excluded from the
    // default unit run, which must stay fast for CI.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/scale.spec.ts'],
    // Fork pool: each test file runs in its own child process, so
    // memory-heavy scale runs cannot perturb unit-test measurements.
    pool: 'forks',
    poolOptions: {
      forks: {
        // Lets scale tests force a full GC before memory measurement.
        execArgv: ['--expose-gc'],
      },
    },
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
