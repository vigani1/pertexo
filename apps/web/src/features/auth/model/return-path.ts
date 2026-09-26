import { authenticationReturnPathSchema } from '@pertexo/contracts/schemas/identity-workspace';

/**
 * Where sign-in may return (ADR 043): only the known same-origin app paths
 * the contract allows. Anything else, including other origins and `//host`,
 * is dropped rather than followed.
 */
export function allowlistedReturnPath(value: unknown): string | undefined {
  const parsed = authenticationReturnPathSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Search params that carry a return path, or none. */
export function returnToSearch(
  returnTo: string | undefined,
): Readonly<{ returnTo?: string }> {
  return returnTo === undefined ? {} : { returnTo };
}

/**
 * The sign-in page a verification link lands on. The server keeps only an
 * allowlisted `returnTo` from it for after the person signs in.
 */
export function verifiedSignInPath(returnTo: string | undefined): string {
  const search = new URLSearchParams({ verified: 'true' });
  if (returnTo !== undefined) search.set('returnTo', returnTo);
  return `/login?${search.toString()}`;
}
