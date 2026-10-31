import { SignUpAvailability } from '@pertexo/database/tenant-access';

const SIGN_UP_PATH = '/v1/auth/sign-up/email';

/**
 * Refuses a closed install's sign-up before Better Auth looks at the address,
 * so the answer is the same for one that has an account and one that doesn't,
 * and no user row or mail exists afterwards.
 */
export async function refuseClosedSignUp(
  request: Request,
  availability: SignUpAvailability,
): Promise<Response | undefined> {
  if (
    request.method !== 'POST' ||
    new URL(request.url).pathname !== SIGN_UP_PATH
  )
    return undefined;
  const body: unknown = await request
    .clone()
    .json()
    .catch(() => undefined);
  const email: unknown =
    typeof body === 'object' && body !== null
      ? Reflect.get(body, 'email')
      : undefined;
  // Better Auth owns refusing a malformed request.
  if (typeof email !== 'string' || (await availability.admits(email)))
    return undefined;
  return Response.json({ code: 'SIGN_UP_CLOSED' }, { status: 403 });
}
