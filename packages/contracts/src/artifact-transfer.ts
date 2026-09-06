import { apiProblemSchema } from './errors/api-problem.js';
import {
  authenticatedComponents,
  jsonRequest,
  jsonResponse,
  jsonSchema,
  problemResponse,
  responseReference,
  uuidPathParameter,
} from './openapi-primitives.js';
import {
  artifactDownloadResponseSchema,
  artifactFinalizeRequestSchema,
  artifactMetadataResponseSchema,
  artifactUploadRequestSchema,
  artifactUploadResponseSchema,
} from './http/artifact-transfer.js';
import { idempotencyKeySchema } from './http/identity-workspace.js';

export * from './http/artifact-transfer.js';

const schemas = Object.freeze({
  ApiProblem: jsonSchema(apiProblemSchema, 'output'),
  ArtifactUploadRequest: jsonSchema(artifactUploadRequestSchema, 'input'),
  ArtifactFinalizeRequest: jsonSchema(artifactFinalizeRequestSchema, 'input'),
  ArtifactMetadataResponse: jsonSchema(
    artifactMetadataResponseSchema,
    'output',
  ),
  ArtifactUploadResponse: jsonSchema(artifactUploadResponseSchema, 'output'),
  ArtifactDownloadResponse: jsonSchema(
    artifactDownloadResponseSchema,
    'output',
  ),
});
export const artifactTransferClientContract = Object.freeze({
  schemaVersion: '1.0.0',
  schemas,
});
const responses = Object.freeze({
  BadRequest: problemResponse('Invalid artifact request'),
  Unauthenticated: problemResponse('Authentication required'),
  Forbidden: problemResponse('CSRF protection failed'),
  NotFound: problemResponse('Artifact or workspace not found'),
  Conflict: problemResponse(
    'Artifact lifecycle, metadata or idempotency conflict',
  ),
  QuotaExceeded: problemResponse('Workspace artifact capacity exceeded'),
  Unavailable: problemResponse('Artifact storage is unavailable'),
  Unexpected: problemResponse('Unexpected server error'),
});
const workspace = uuidPathParameter('workspaceId');
const artifact = uuidPathParameter('artifactId');
const csrf = {
  name: 'x-csrf-token',
  in: 'header',
  required: true,
  schema: { type: 'string', minLength: 1 },
} as const;
const idempotency = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  schema: jsonSchema(idempotencyKeySchema, 'input'),
} as const;
const security = [{ cookieSession: [] }] as const;
const errors = {
  '400': responseReference('BadRequest'),
  '401': responseReference('Unauthenticated'),
  '403': responseReference('Forbidden'),
  '404': responseReference('NotFound'),
  '409': responseReference('Conflict'),
  '429': responseReference('QuotaExceeded'),
  '503': responseReference('Unavailable'),
  '500': responseReference('Unexpected'),
};
function privateResponse(description: string, name: string) {
  return {
    ...jsonResponse(description, name),
    headers: {
      'Cache-Control': {
        description: 'Never cache artifact capabilities or metadata',
        schema: { type: 'string', const: 'no-store' },
      },
    },
  };
}

export const artifactTransferOpenApiDocument = Object.freeze({
  openapi: '3.1.0',
  info: { title: 'Pertexo Artifacts API', version: '1.0.0' },
  components: authenticatedComponents(schemas, responses),
  paths: {
    '/v1/workspaces/{workspaceId}/artifacts/uploads': {
      post: {
        operationId: 'beginArtifactUpload',
        security,
        parameters: [workspace, csrf, idempotency],
        requestBody: jsonRequest('ArtifactUploadRequest'),
        responses: {
          ...errors,
          '201': privateResponse(
            'Pending artifact and immutable upload capability',
            'ArtifactUploadResponse',
          ),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/artifacts/{artifactId}/finalize': {
      post: {
        operationId: 'finalizeArtifactUpload',
        security,
        parameters: [workspace, artifact, csrf],
        requestBody: jsonRequest('ArtifactFinalizeRequest'),
        responses: {
          ...errors,
          '200': privateResponse(
            'Verified available artifact',
            'ArtifactMetadataResponse',
          ),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/artifacts/{artifactId}': {
      get: {
        operationId: 'getArtifactMetadata',
        security,
        parameters: [workspace, artifact],
        responses: {
          ...errors,
          '200': privateResponse(
            'Authorized artifact metadata without a storage key',
            'ArtifactMetadataResponse',
          ),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/artifacts/{artifactId}/download': {
      get: {
        operationId: 'beginArtifactDownload',
        security,
        parameters: [workspace, artifact],
        responses: {
          ...errors,
          '200': privateResponse(
            'Short-lived attachment download capability',
            'ArtifactDownloadResponse',
          ),
        },
      },
    },
  },
});
