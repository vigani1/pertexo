import {
  invitationAcceptanceCompleteRequestSchema,
  invitationAcceptanceJourneySchema,
  invitationAcceptanceOidcRequestSchema,
  invitationAcceptanceReceiptSchema,
  invitationAcceptanceResolveRequestSchema,
  oidcStartResponseSchema,
  type InvitationAcceptanceJourney,
  type InvitationAcceptanceReceipt,
} from '@pertexo/contracts/schemas/identity-workspace';
import type { ApiClient } from '@/lib/api/client';

export function resolveInvitation(
  apiClient: ApiClient,
  token: string,
  signal?: AbortSignal,
): Promise<InvitationAcceptanceJourney> {
  return apiClient.request({
    path: '/v1/invitation-acceptance/resolve',
    method: 'POST',
    csrf: 'external',
    headers: { 'X-Pertexo-Invitation-Request': 'resolve' },
    body: invitationAcceptanceResolveRequestSchema.parse({ token }),
    ...(signal === undefined ? {} : { signal }),
    response: {
      kind: 'json',
      decode: (value) => invitationAcceptanceJourneySchema.parse(value),
    },
  });
}

export function readInvitation(
  apiClient: ApiClient,
  signal?: AbortSignal,
): Promise<InvitationAcceptanceJourney> {
  return apiClient.request({
    path: '/v1/invitation-acceptance',
    ...(signal === undefined ? {} : { signal }),
    response: {
      kind: 'json',
      decode: (value) => invitationAcceptanceJourneySchema.parse(value),
    },
  });
}

export function startInvitationOidc(
  apiClient: ApiClient,
  csrfToken: string,
  signal?: AbortSignal,
) {
  return apiClient.request({
    path: '/v1/invitation-acceptance/oidc',
    method: 'POST',
    csrf: 'external',
    headers: { 'X-Invitation-Csrf-Token': csrfToken },
    body: invitationAcceptanceOidcRequestSchema.parse({}),
    ...(signal === undefined ? {} : { signal }),
    response: {
      kind: 'json',
      decode: (value) => oidcStartResponseSchema.parse(value),
    },
  });
}

export function completeInvitation(
  apiClient: ApiClient,
  input: Readonly<{
    intentId: string;
    expectedRevision: number;
    csrfToken: string;
    idempotencyKey: string;
  }>,
): Promise<InvitationAcceptanceReceipt> {
  return apiClient.request({
    path: '/v1/invitation-acceptance/complete',
    method: 'POST',
    headers: {
      'Idempotency-Key': input.idempotencyKey,
      'X-Invitation-Csrf-Token': input.csrfToken,
    },
    body: invitationAcceptanceCompleteRequestSchema.parse({
      intentId: input.intentId,
      expectedRevision: input.expectedRevision,
    }),
    response: {
      kind: 'json',
      decode: (value) => invitationAcceptanceReceiptSchema.parse(value),
    },
  });
}

export function abandonInvitation(
  apiClient: ApiClient,
  csrfToken: string,
  signal?: AbortSignal,
) {
  return apiClient.request({
    path: '/v1/invitation-acceptance',
    method: 'DELETE',
    csrf: 'external',
    headers: { 'X-Invitation-Csrf-Token': csrfToken },
    ...(signal === undefined ? {} : { signal }),
    response: { kind: 'empty' },
  });
}
