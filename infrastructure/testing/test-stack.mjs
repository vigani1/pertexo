/**
 * Integration tests reach PostgreSQL and Redis only through settings someone
 * gave them. A missing setting used to fall back to localhost:5432 and the
 * dev credentials, which is the developer's own stack: two runs wrote test
 * databases there. Now the harness refuses instead.
 */
export const TEST_STACK_SETTINGS = Object.freeze([
  'DATABASE_URL',
  'DATABASE_ADMIN_URL',
  'DATABASE_MIGRATION_URL',
  'DATABASE_MAINTENANCE_URL',
  'REDIS_URL',
]);

const GUIDE = 'see README.md#integration-tests';

/** The named setting, or a refusal that says which one is missing and why. */
export function testStackSetting(name, environment = process.env) {
  const value = environment[name];
  if (value === undefined || value.trim() === '')
    throw new Error(
      `Integration tests need ${name} from a test stack, set explicitly; ${GUIDE}. They never fall back to the local development stack.`,
    );
  return value;
}

/** Refuses before any test file loads when a setting the suite needs is missing. */
export function requireTestStack(
  names = TEST_STACK_SETTINGS,
  environment = process.env,
) {
  const missing = names.filter((name) => {
    const value = environment[name];
    return value === undefined || value.trim() === '';
  });
  if (missing.length > 0)
    throw new Error(
      `Integration tests need ${missing.join(', ')} from a test stack, set explicitly; ${GUIDE}. They never fall back to the local development stack.`,
    );
}
