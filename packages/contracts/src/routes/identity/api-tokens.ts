import {
  ACTIVE_WORKSPACE_STATUSES,
  BROWSABLE_WORKSPACE_STATUSES,
  type WorkspaceStatusList,
} from '@pertexo/policy';
import { z } from 'zod';

import { problemResponse } from '../openapi-primitives.js';
import {
  apiTokenCreateRequestSchema,
  apiTokenCreateResponseSchema,
  apiTokenListQuerySchema,
  apiTokenListResponseSchema,
  apiTokenRevokeRequestSchema,
  apiTokenRevokeResponseSchema,
} from '../../schemas/identity/api-tokens.js';
import { defineRoute, named, type RouteAccess } from '../define.js';

const ROOT = '/v1/workspaces/{workspaceId}/api-tokens';
const workspace = z.object({ workspaceId: z.uuid() }).strict();

/** Members manage only their own tokens, so a member check is enough here. */
function member(statuses: WorkspaceStatusList): RouteAccess {
  return {
    auth: 'session',
    capabilities: [
      { name: 'workspace:read', statuses, disclosure: 'forbidden' },
    ],
  };
}
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
const noStore = 'private, no-store';
/** A token secret or its metadata must never sit in a cache. */
export const noStoreHeader = {
  'Cache-Control': {
    required: true,
    schema: { type: 'string', const: noStore },
  },
};

export const apiTokenRoutes = {
  list: defineRoute({
    operationId: 'listApiTokens',
    method: 'get',
    path: ROOT,
    params: workspace,
    query: apiTokenListQuerySchema,
    access: member(BROWSABLE_WORKSPACE_STATUSES),
    rateLimit: 'authenticated_read',
    cacheControl: noStore,
    description:
      'Own token metadata only. Secrets cannot be retrieved. Disabled servers retain listing and revocation.',
    success: {
      status: 200,
      description: 'Token metadata and availability',
      body: named('ApiTokenListResponse', apiTokenListResponseSchema),
      headers: noStoreHeader,
    },
    problems: errors,
  }),
  create: defineRoute({
    operationId: 'createApiToken',
    method: 'post',
    path: ROOT,
    params: workspace,
    access: member(ACTIVE_WORKSPACE_STATUSES),
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    cacheControl: noStore,
    description:
      'Browser-only, with sign-in evidence from the last five minutes. First success returns the secret once. Exact command replay returns metadata without a secret.',
    body: named('ApiTokenCreateRequest', apiTokenCreateRequestSchema),
    success: {
      status: 201,
      description: 'One-time credential or safe replay metadata',
      body: named('ApiTokenCreateResponse', apiTokenCreateResponseSchema),
      headers: noStoreHeader,
    },
    problems: errors,
  }),
  revoke: defineRoute({
    operationId: 'revokeApiToken',
    method: 'post',
    path: `${ROOT}/{tokenId}/revoke`,
    params: workspace.extend({ tokenId: z.uuid() }),
    access: member(ACTIVE_WORKSPACE_STATUSES),
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    cacheControl: noStore,
    description:
      'Browser-only revocation. Already accepted runs continue; subsequent token verification fails.',
    body: named('ApiTokenRevokeRequest', apiTokenRevokeRequestSchema),
    success: {
      status: 200,
      description: 'Revoked token metadata',
      body: named('ApiTokenRevokeResponse', apiTokenRevokeResponseSchema),
      headers: noStoreHeader,
    },
    problems: errors,
  }),
};
