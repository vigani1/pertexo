// The database package refuses a pool whose fresh connection already carries
// app.* settings (InheritedSessionContextError). Its text never reaches a log;
// this builds the operator's description from its checked fields alone.
// Observability can't depend on the database package, so the pool roles and
// the error's name and fields are repeated here; the API's process-failure
// test requires DESCRIBED_POOL_ROLES to equal DATABASE_POOL_ROLES and
// describes a real refusal for every role and every APP_SETTING_NAMES name,
// so the copies can't drift apart unnoticed.

/** The pool roles a refusal may name; the API test holds them equal to the database's. */
export const DESCRIBED_POOL_ROLES: readonly string[] = Object.freeze([
  'api',
  'dispatcher',
  'maintenance',
  'other',
  'worker',
]);
const POOL_ROLES = new Set(DESCRIBED_POOL_ROLES);
const SETTING_NAME = /^app\.[a-z0-9_]+$/u;
const MAX_SETTINGS = 32;

/** The refusal's safe description, or undefined when the error isn't one or doesn't check out. */
export function describeInheritedSessionContext(
  error: unknown,
): string | undefined {
  if (
    !(error instanceof Error) ||
    error.name !== 'InheritedSessionContextError'
  )
    return undefined;
  const { role, settings } = error as Error & {
    role?: unknown;
    settings?: unknown;
  };
  if (typeof role !== 'string' || !POOL_ROLES.has(role)) return undefined;
  if (
    !Array.isArray(settings) ||
    settings.length === 0 ||
    settings.length > MAX_SETTINGS ||
    !settings.every(
      (name): name is string =>
        typeof name === 'string' && SETTING_NAME.test(name),
    )
  )
    return undefined;
  return (
    `the ${role} database pool refused a connection that already carries ${settings.join(', ')}; ` +
    'remove it from PGOPTIONS, the connection string options, or the role or database defaults'
  );
}
