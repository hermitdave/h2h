import { defineConfig } from 'vitest/config';

/**
 * Dedicated config for the opt-in scale run (SCALE_TESTS=1).
 *
 * The unit config excludes tests/scale.spec.ts so that the fast CI
 * unit run never collects it; this config does the opposite — it
 * includes ONLY the scale spec, in its own forked process, so memory
 * measurements are clean and the 30-minute test timeout applies.
 */
export default defineConfig({
  test: {
    include: ['tests/scale.spec.ts'],
    pool: 'forks',
    poolOptions: {
      forks: {
        // Lets scale tests force a full GC before memory measurement.
        execArgv: ['--expose-gc'],
      },
    },
    testTimeout: 1_800_000,
    hookTimeout: 60_000,
  },
});
