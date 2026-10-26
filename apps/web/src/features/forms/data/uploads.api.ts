import {
  formUploadResponseSchema,
  formUploadSchema,
  type FormUploadMetadata,
  type FormUploadResponse,
} from '@pertexo/contracts';
import type { ApiClient } from '@/lib/api/client';
import type { FormScope } from './forms.api';

export type FormUploadRequest = Readonly<{
  fieldId: string;
  filename: string;
  byteLength: number;
  sha256: string;
}>;

/** Where one response's files go: a form link, a member form or an input request. */
export type FormUploadTarget = Readonly<{
  /** Sent with the response so its uploads count; one per response. */
  session: string;
  begin(
    request: FormUploadRequest,
    key: string,
    signal: AbortSignal,
  ): Promise<FormUploadResponse>;
  finalize(uploadId: string, signal: AbortSignal): Promise<FormUploadMetadata>;
}>;

export const UPLOAD_SESSION_HEADER = 'x-pertexo-form-session';

export function newUploadSession(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

/** One owner for the begin and finalize calls of any upload path. */
export function uploadTarget({
  apiClient,
  path,
  session,
  headers = {},
  body = {},
  external = false,
}: Readonly<{
  apiClient: ApiClient;
  path: `/v1${string}`;
  session: string;
  headers?: Readonly<Record<string, string>>;
  body?: Readonly<Record<string, string>>;
  external?: boolean;
}>): FormUploadTarget {
  const shared = {
    method: 'POST' as const,
    ...(external ? { csrf: 'external' as const } : {}),
  };
  return {
    session,
    begin: (request, key, signal) =>
      apiClient.request({
        ...shared,
        path: `${path}/uploads`,
        headers: {
          ...headers,
          [UPLOAD_SESSION_HEADER]: session,
          'Idempotency-Key': key,
        },
        body: { ...body, ...request },
        signal,
        response: {
          kind: 'json',
          decode: (value) => formUploadResponseSchema.parse(value),
        },
      }),
    finalize: (uploadId, signal) =>
      apiClient.request({
        ...shared,
        path: `${path}/uploads/${encodeURIComponent(uploadId)}/finalize`,
        headers: { ...headers, [UPLOAD_SESSION_HEADER]: session },
        body: {},
        signal,
        response: {
          kind: 'json',
          decode: (value) => formUploadSchema.parse(value),
        },
      }),
  };
}

export function formUploadTarget(
  scope: FormScope,
  versionId: string,
  session: string,
): FormUploadTarget {
  const target = scope.target;
  return target.kind === 'public'
    ? uploadTarget({
        apiClient: scope.apiClient,
        path: `/v1/forms/${encodeURIComponent(target.publicId)}`,
        session,
        headers: { 'x-pertexo-form-key': target.capability },
        body: { versionId },
        external: true,
      })
    : uploadTarget({
        apiClient: scope.apiClient,
        path: `/v1/workspaces/${encodeURIComponent(target.workspaceId)}/workflows/${encodeURIComponent(target.workflowId)}/form`,
        session,
        body: { versionId },
      });
}
