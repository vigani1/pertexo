import {
  coordinatedEventHistorySchema,
  formCapabilitySchema,
  formSchemaResponseSchema,
  formSubmissionResponseSchema,
  publicFormSubmissionResponseSchema,
  formAccessSchema,
  type FormSubmissionRequest,
  type FormSubmissionResponse,
  type FormAccessRequest,
} from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import { UPLOAD_SESSION_HEADER } from './uploads.api';
export type MemberFormScope = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
}>;
export type FormScope = Readonly<{
  apiClient: ApiClient;
  target:
    | Readonly<{
        kind: 'member';
        userId: string;
        workspaceId: string;
        workflowId: string;
      }>
    | Readonly<{
        kind: 'public';
        publicId: string;
        capability: string;
        authority: string;
      }>;
}>;
export function memberFormScope(scope: MemberFormScope): FormScope {
  return {
    apiClient: scope.apiClient,
    target: {
      kind: 'member',
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      workflowId: scope.workflowId,
    },
  };
}
export async function publicFormScope(
  apiClient: ApiClient,
  publicId: string,
  fragment: string,
): Promise<FormScope | null> {
  const parsed = formCapabilitySchema.safeParse(fragment.replace(/^#/, ''));
  if (!parsed.success) return null;
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(parsed.data),
  );
  const authority = Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return {
    apiClient,
    target: { kind: 'public', publicId, capability: parsed.data, authority },
  };
}
function targetPath(scope: FormScope): `/v1${string}` {
  const target = scope.target;
  return target.kind === 'public'
    ? `/v1/forms/${encodeURIComponent(target.publicId)}`
    : `/v1/workspaces/${encodeURIComponent(target.workspaceId)}/workflows/${encodeURIComponent(target.workflowId)}/form`;
}
function publicHeaders(scope: FormScope) {
  return scope.target.kind === 'public'
    ? { 'x-pertexo-form-key': scope.target.capability }
    : {};
}
export function readForm(scope: FormScope, signal?: AbortSignal) {
  return scope.apiClient.request({
    path: targetPath(scope),
    headers: publicHeaders(scope),
    ...(signal === undefined ? {} : { signal }),
    response: {
      kind: 'json',
      decode: (value) => formSchemaResponseSchema.parse(value),
    },
  });
}
/** The upload session names the files this response may use. */
export function sendForm(
  scope: FormScope,
  body: FormSubmissionRequest,
  key: string,
  session: string,
): Promise<FormSubmissionResponse> {
  return scope.apiClient.request({
    path: `${targetPath(scope)}/submit`,
    method: 'POST',
    ...(scope.target.kind === 'public' ? { csrf: 'external' as const } : {}),
    headers: {
      ...publicHeaders(scope),
      [UPLOAD_SESSION_HEADER]: session,
      'Idempotency-Key': key,
    },
    body,
    response: {
      kind: 'json',
      decode: (value) =>
        (scope.target.kind === 'public'
          ? publicFormSubmissionResponseSchema
          : formSubmissionResponseSchema
        ).parse(value),
    },
  });
}
const accessPath = (scope: MemberFormScope): `/v1${string}` =>
  `/v1/workspaces/${encodeURIComponent(scope.workspaceId)}/workflows/${encodeURIComponent(scope.workflowId)}/form/access`;
export function readFormAccess(scope: MemberFormScope, signal?: AbortSignal) {
  return scope.apiClient.request({
    path: accessPath(scope),
    ...(signal === undefined ? {} : { signal }),
    response: {
      kind: 'json',
      decode: (value) => formAccessSchema.parse(value),
    },
  });
}
export function setFormAccess(
  scope: MemberFormScope,
  body: FormAccessRequest,
  key: string,
) {
  return scope.apiClient.request({
    path: accessPath(scope),
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body,
    response: {
      kind: 'json',
      decode: (value) => formAccessSchema.parse(value),
    },
  });
}

export function readFormEvents(
  scope: MemberFormScope,
  cursor: Readonly<{ receivedAt: string; id: string }> | null,
  signal: AbortSignal,
) {
  const query = new URLSearchParams({ limit: '25' });
  if (cursor !== null) {
    query.set('before', cursor.receivedAt);
    query.set('beforeId', cursor.id);
  }
  return scope.apiClient.request({
    path: `/v1/workspaces/${encodeURIComponent(scope.workspaceId)}/workflows/${encodeURIComponent(scope.workflowId)}/form/events?${query.toString()}`,
    signal,
    response: {
      kind: 'json',
      decode: (value) => coordinatedEventHistorySchema.parse(value),
    },
  });
}
