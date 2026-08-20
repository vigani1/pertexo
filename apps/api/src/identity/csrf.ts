import { z } from 'zod';

import {
  constantTimeStringEqual,
  encodeBase64Url,
  nodeIdentityCrypto,
} from './crypto.js';
import { IdentityError } from './errors.js';
import type { IdentityCrypto } from './crypto.js';

const csrfTokenSchema = z.string().min(16).max(256);
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
    try {
      cookieToken = csrfTokenSchema.parse(input.cookieToken);
      headerToken = csrfTokenSchema.parse(input.headerToken);
    } catch {
      throw new IdentityError('identity.csrf_failed');
    }
    if (!constantTimeStringEqual(cookieToken, headerToken, this.crypto)) {
      throw new IdentityError('identity.csrf_failed');
    }
  }
}
