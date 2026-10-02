/** Public, fixed evidence codes only; never forward arbitrary startup diagnostics. */
export function organizationStartupFailure(error) {
  return error instanceof Error &&
    error.message === 'Database migration head is incompatible'
    ? 'migration-head-incompatible'
    : 'startup-failed';
}
