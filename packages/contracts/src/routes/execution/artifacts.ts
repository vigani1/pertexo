import {
  ACTIVE_WORKSPACE_STATUSES,
  BROWSABLE_WORKSPACE_STATUSES,
} from '@pertexo/policy';
import { responseReference } from '../../openapi/primitives.js';
import {
  artifactDownloadResponseSchema,
  artifactFinalizeRequestSchema,
  artifactMetadataResponseSchema,
  artifactParamsSchema,
  artifactUploadRequestSchema,
  artifactUploadResponseSchema,
  artifactWorkspaceParamsSchema,
} from '../../schemas/execution/artifact-transfer.js';
import { defineRoute, named, type RouteAccess } from '../define.js';

const ROOT = '/v1/workspaces/{workspaceId}/artifacts';
const workspace = artifactWorkspaceParamsSchema;
const artifact = artifactParamsSchema;

const uploading: RouteAccess = {
  auth: 'session',
  capabilities: [
    {
      name: 'artifact:upload',
      statuses: ACTIVE_WORKSPACE_STATUSES,
      disclosure: 'not_found',
    },
  ],
};
const reading: RouteAccess = {
  auth: 'session',
  capabilities: [
    {
      name: 'artifact:read',
      statuses: BROWSABLE_WORKSPACE_STATUSES,
      disclosure: 'not_found',
    },
  ],
};
const shared = {
  // A capability or a file's metadata must never sit in a cache.
  cacheControl: 'no-store',
  problems: {
    '400': responseReference('BadRequest'),
    '401': responseReference('Unauthenticated'),
    '403': responseReference('Forbidden'),
    '404': responseReference('NotFound'),
    '409': responseReference('Conflict'),
    '413': responseReference('TooLarge'),
    '429': responseReference('QuotaExceeded'),
    '503': responseReference('Unavailable'),
    '500': responseReference('Unexpected'),
  },
} as const;
const noStore = {
  'Cache-Control': {
    description: 'Never cache artifact capabilities or metadata',
    schema: { type: 'string', const: 'no-store' },
  },
};
const metadata = named(
  'ArtifactMetadataResponse',
  artifactMetadataResponseSchema,
);

export const artifactRoutes = {
  beginUpload: defineRoute({
    ...shared,
    operationId: 'beginArtifactUpload',
    method: 'post',
    path: `${ROOT}/uploads`,
    params: workspace,
    access: uploading,
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    body: named('ArtifactUploadRequest', artifactUploadRequestSchema),
    success: {
      status: 201,
      description: 'Pending artifact and immutable upload capability',
      body: named('ArtifactUploadResponse', artifactUploadResponseSchema),
      headers: noStore,
    },
  }),
  finalizeUpload: defineRoute({
    ...shared,
    operationId: 'finalizeArtifactUpload',
    method: 'post',
    path: `${ROOT}/{artifactId}/finalize`,
    params: artifact,
    access: uploading,
    rateLimit: 'ordinary_mutation',
    body: named('ArtifactFinalizeRequest', artifactFinalizeRequestSchema),
    success: {
      status: 200,
      description: 'Verified available artifact',
      body: metadata,
      headers: noStore,
    },
  }),
  metadata: defineRoute({
    ...shared,
    operationId: 'getArtifactMetadata',
    method: 'get',
    path: `${ROOT}/{artifactId}`,
    params: artifact,
    access: reading,
    rateLimit: 'authenticated_read',
    success: {
      status: 200,
      description: 'Authorized artifact metadata without a storage key',
      body: metadata,
      headers: noStore,
    },
  }),
  beginDownload: defineRoute({
    ...shared,
    operationId: 'beginArtifactDownload',
    method: 'get',
    path: `${ROOT}/{artifactId}/download`,
    params: artifact,
    access: reading,
    rateLimit: 'authenticated_read',
    success: {
      status: 200,
      description: 'Short-lived attachment download capability',
      body: named('ArtifactDownloadResponse', artifactDownloadResponseSchema),
      headers: noStore,
    },
  }),
};
