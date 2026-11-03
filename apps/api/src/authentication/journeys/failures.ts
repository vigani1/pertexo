import { Logger } from '@nestjs/common';
import type { FederationFailureReason } from '@pertexo/contracts';
import type { DirectoryError } from '@pertexo/core/identity';
import { parseRequestId } from '../../platform/http/request-context.js';

type AuthenticationFlow =
  | 'social_start'
  | 'social_callback'
  | 'link_start'
  | 'link_callback'
  | 'oidc_start'
  | 'saml_start'
  | 'oidc_callback'
  | 'saml_callback'
  | 'directory';
export type AuthenticationFailureReason =
  | FederationFailureReason
  | DirectoryError['reason']
  | 'provider_unavailable'
  | 'storage_unavailable'
  | 'session_delivery_failed'
  | 'proof_refused'
  | 'request_invalid'
  | 'internal_failure';
const logger = new Logger('Authentication');

/** Library errors may contain proofs or SQL values; only owned codes cross this boundary. */
export function recordAuthenticationFailure(
  requestId: string | null | undefined,
  flow: AuthenticationFlow,
  reason: AuthenticationFailureReason,
  kind: 'refused' | 'failed',
): void {
  const message = `Authentication ${kind}: ${flow} ${reason} requestId=${parseRequestId(requestId) ?? 'unavailable'}`;
  if (kind === 'refused') logger.warn(message);
  else logger.error(message);
}
