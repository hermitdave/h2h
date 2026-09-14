/** Jest config — unit suites run fast; performance suite has its own timeout. */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.spec.ts'],
  testTimeout: 30000,
};
