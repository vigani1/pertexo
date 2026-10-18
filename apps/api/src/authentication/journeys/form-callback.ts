const formCallbacks = new Map<string, 'landing' | 'proof'>([
  ['/v1/auth/federation/social/callback/apple', 'landing'],
  ['/v1/auth/account-security/methods/link/callback/apple', 'landing'],
  ['/v1/auth/federation/saml/callback', 'proof'],
]);

export function isProviderFormCallback(
  method: string,
  pathname: string,
): boolean {
  return method === 'POST' && formCallbacks.has(pathname);
}

/**
 * Apple posts across sites. A same-origin GET landing lets the ordinary Lax
 * session and journey cookies authorize the proof without weakening cookies.
 * This transport performs no identity change; the GET still verifies the proof.
 */
export async function landProviderFormCallback(
  request: Request,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (
    request.method !== 'POST' ||
    formCallbacks.get(url.pathname) !== 'landing'
  )
    return undefined;
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
      'application/x-www-form-urlencoded' ||
    url.search.length !== 0
  )
    return new Response(null, { status: 400 });
  const body = await request.text();
  if (Buffer.byteLength(body) > 32_768)
    return new Response(null, { status: 400 });
  const fields = new URLSearchParams(body);
  for (const [name, maximum] of [
    ['state', 43],
    ['code', 4096],
    ['iss', 2048],
  ] as const) {
    const values = fields.getAll(name);
    if (values.length > 1 || (values[0]?.length ?? 0) > maximum)
      return new Response(null, { status: 400 });
    if (values[0] !== undefined) url.searchParams.set(name, values[0]);
  }
  if (fields.has('error')) url.searchParams.set('error', 'provider_rejected');
  return new Response(null, {
    status: 303,
    headers: {
      location: url.toString(),
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}
