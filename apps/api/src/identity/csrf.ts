import { csrfTokenSchema } from '@pertexo/contracts';

import {
  constantTimeStringEqual,
  encodeBase64Url,
  nodeIdentityCrypto,
} from './crypto.js';
import { IdentityError } from './identity.errors.js';
import type { IdentityCrypto } from './crypto.js';

const mutationMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export type CsrfMutationInput = Readonly<{
  method: string;
  cookieToken?: string;
  headerToken?: string;
}>;

/** Double-submit CSRF policy for authenticated cookie mutations. */
export class DoubleSubmitCsrfPolicy {
  constructor(private readonly crypto: IdentityCrypto = nodeIdentityCrypto) {}

  issueToken(): string {
    return encodeBase64Url(this.crypto.randomBytes(32));
  }

  assertMutationAllowed(input: CsrfMutationInput): void {
    if (!mutationMethods.has(input.method.toUpperCase())) return;
    let cookieToken: string;
    let headerToken: string;
    let decoded: string | undefined;
    try {
      decoded =
        input.cookieToken === undefined
          ? undefined
          : decodeURIComponent(input.cookieToken);
    } catch {
      throw new IdentityError('identity.csrf_malformed');
    }
    try {
      cookieToken = csrfTokenSchema.parse(decoded);
      headerToken = csrfTokenSchema.parse(input.headerToken);
    } catch {
      throw new IdentityError('identity.csrf_failed');
    }
    if (!constantTimeStringEqual(cookieToken, headerToken, this.crypto)) {
      throw new IdentityError('identity.csrf_failed');
    }
  }
}

/** Decode the wire cookie once before applying the shared proof policy. */
export function browserCsrfRefusal(
  headers: Headers | undefined,
): 400 | 403 | undefined {
  const raw = headers
    ?.get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('pertexo_csrf='))
    ?.slice('pertexo_csrf='.length);
  const headerToken = headers?.get('x-csrf-token') ?? undefined;
  try {
    new DoubleSubmitCsrfPolicy().assertMutationAllowed({
      method: 'POST',
      ...(raw === undefined ? {} : { cookieToken: raw }),
      ...(headerToken === undefined ? {} : { headerToken }),
    });
    return undefined;
  } catch (error: unknown) {
    return error instanceof IdentityError &&
      error.code === 'identity.csrf_malformed'
      ? 400
      : 403;
  }
}
