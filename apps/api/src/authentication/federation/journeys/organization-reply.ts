export function failure(status: number) {
  return Response.json(
    { code: 'ORGANIZATION_SIGN_IN_UNAVAILABLE' },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}
