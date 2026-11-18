// Apart from db.ts so scripts (scripts/e2e) can reach the test database without db.ts's node:test hooks, which would
// turn the script into a test run.

// Tests run as their own role, not devrounds_app: roles are cluster-wide and the server sets a different password.
export const TEST_APP_ROLE = 'devrounds_test_app'
export const TEST_APP_PASSWORD = 'devrounds'
export const TEST_DATABASE_URL =
  process.env.DEVROUNDS_TEST_DATABASE_URL ??
  `postgres://${TEST_APP_ROLE}:${TEST_APP_PASSWORD}@127.0.0.1:15433/devrounds_test`
export const TEST_ADMIN_URL =
  process.env.DEVROUNDS_TEST_ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:15433/devrounds_test'
