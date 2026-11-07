import type { FederationFailureReason } from '@pertexo/contracts';

export function failure(status: number) {
  return Response.json(
    { code: 'ORGANIZATION_SIGN_IN_UNAVAILABLE' },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}

export function organizationLanding(
  baseUrl: string,
  path: string,
  test?: 'passed' | Readonly<{ failed: FederationFailureReason }>,
): Response {
  const destination = new URL(path, baseUrl);
  if (test === 'passed') destination.searchParams.set('ssoTest', 'passed');
  else if (test !== undefined) {
    destination.searchParams.set('ssoTest', 'failed');
    destination.searchParams.set('ssoReason', test.failed);
  }
  return new Response(null, {
    status: 302,
    headers: {
      location: destination.toString(),
      'cache-control': 'no-store',
    },
  });
}
