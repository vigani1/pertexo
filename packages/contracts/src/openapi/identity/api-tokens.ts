import {
  apiTokenCreateRequestSchema,
  apiTokenCreateResponseSchema,
  apiTokenInfoResponseSchema,
  apiTokenListResponseSchema,
  apiTokenListQuerySchema,
  apiTokenRevokeRequestSchema,
  apiTokenRevokeResponseSchema,
} from '../../schemas/identity/api-tokens.js';
import {
  csrfHeaderParameter,
  idempotencyHeaderParameter,
  jsonRequest,
  jsonResponse,
  jsonSchema,
  problemResponse,
  queryParameter,
  uuidPathParameter,
} from '../primitives.js';

export const apiTokenContractSchemas = {
  ApiTokenCreateRequest: jsonSchema(apiTokenCreateRequestSchema, 'input'),
  ApiTokenCreateResponse: jsonSchema(apiTokenCreateResponseSchema, 'output'),
  ApiTokenInfoResponse: jsonSchema(apiTokenInfoResponseSchema, 'output'),
  ApiTokenListResponse: jsonSchema(apiTokenListResponseSchema, 'output'),
  ApiTokenRevokeRequest: jsonSchema(apiTokenRevokeRequestSchema, 'input'),
  ApiTokenRevokeResponse: jsonSchema(apiTokenRevokeResponseSchema, 'output'),
};
const workspace = uuidPathParameter('workspaceId');
const noStore = {
  'Cache-Control': {
    required: true,
    schema: { type: 'string', const: 'private, no-store' },
  },
};
const errors = {
  '400': problemResponse('Invalid request'),
  '401': problemResponse('Browser session required'),
  '403': problemResponse('Permission or recent sign-in required'),
  '404': problemResponse('Token or workspace not found'),
  '409': problemResponse('Command conflict or active token limit'),
  '429': problemResponse('Rate limited'),
  '503': problemResponse('Automation tokens or rate limiter unavailable'),
  '500': problemResponse('Unexpected server error'),
};
export const apiTokenContractPaths = {
  '/v1/token': {
    get: {
      operationId: 'readCurrentApiToken',
      description:
        'The calling token itself: its workspace, scopes and expiry. Secrets stay unavailable.',
      security: [{ apiToken: [] }],
      responses: {
        '200': {
          ...jsonResponse('This token', 'ApiTokenInfoResponse'),
          headers: noStore,
        },
        '401': problemResponse('Valid API token required'),
        '429': problemResponse('Rate limited'),
        '503': problemResponse('Automation tokens or rate limiter unavailable'),
        '500': problemResponse('Unexpected server error'),
      },
    },
  },
  '/v1/workspaces/{workspaceId}/api-tokens': {
    get: {
      operationId: 'listApiTokens',
      description:
        'Own token metadata only. Secrets cannot be retrieved. Disabled servers retain listing and revocation.',
      security: [{ cookieSession: [] }],
      parameters: [
        workspace,
        queryParameter('limit', apiTokenListQuerySchema.shape.limit),
        queryParameter('after', apiTokenListQuerySchema.shape.after),
      ],
      responses: {
        ...errors,
        '200': {
          ...jsonResponse(
            'Token metadata and availability',
            'ApiTokenListResponse',
          ),
          headers: noStore,
        },
      },
    },
    post: {
      operationId: 'createApiToken',
      description:
        'Browser-only, with sign-in evidence from the last five minutes. First success returns the secret once. Exact command replay returns metadata without a secret.',
      security: [{ cookieSession: [] }],
      parameters: [
        workspace,
        csrfHeaderParameter(),
        idempotencyHeaderParameter(),
      ],
      requestBody: jsonRequest('ApiTokenCreateRequest'),
      responses: {
        ...errors,
        '201': {
          ...jsonResponse(
            'One-time credential or safe replay metadata',
            'ApiTokenCreateResponse',
          ),
          headers: noStore,
        },
      },
    },
  },
  '/v1/workspaces/{workspaceId}/api-tokens/{tokenId}/revoke': {
    post: {
      operationId: 'revokeApiToken',
      description:
        'Browser-only revocation. Already accepted runs continue; subsequent token verification fails.',
      security: [{ cookieSession: [] }],
      parameters: [
        workspace,
        uuidPathParameter('tokenId'),
        csrfHeaderParameter(),
        idempotencyHeaderParameter(),
      ],
      requestBody: jsonRequest('ApiTokenRevokeRequest'),
      responses: {
        ...errors,
        '200': {
          ...jsonResponse('Revoked token metadata', 'ApiTokenRevokeResponse'),
          headers: noStore,
        },
      },
    },
  },
};
