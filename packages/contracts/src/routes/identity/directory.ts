import {
  BROWSABLE_WORKSPACE_STATUSES,
  UNPURGED_WORKSPACE_STATUSES,
} from '@pertexo/policy';
import { z } from 'zod';
import { problemResponse } from '../openapi-primitives.js';
import * as schemas from '../../schemas/identity/federation/directory.js';
import { named as projected } from '../define.js';
const reading = {
  auth: 'session',
  capabilities: [
    {
      name: 'member:read',
      statuses: BROWSABLE_WORKSPACE_STATUSES,
      disclosure: 'forbidden',
    },
  ],
} as const;
const managing = {
  auth: 'session',
  capabilities: [
    {
      name: 'workspace:manage',
      statuses: UNPURGED_WORKSPACE_STATUSES,
      disclosure: 'forbidden',
    },
  ],
} as const;
const workspace = z.object({ workspaceId: z.uuid() }).strict();

import { defineRoute } from '../define.js';
const sharedProblems1 = {
  '400': problemResponse('Invalid directory values or limit reached'),
  '401': problemResponse('Session required'),
  '403': problemResponse('Owner authority or CSRF refused'),
  '404': problemResponse('Directory unavailable'),
  '409': problemResponse('Reviewed settings changed or command conflict'),
  '429': problemResponse('Rate limited'),
  '500': problemResponse('Unexpected failure'),
};
const managementCommand = {
  method: 'post',
  access: managing,
  rateLimit: 'ordinary_mutation',
  idempotent: true,
  success: {
    status: 200,
    description: 'Safe directory metadata',
    body: projected('DirectoryChanged', schemas.directoryChangedSchema),
  },
  problems: sharedProblems1,
} as const;
export const directoryRoutes = {
  settings: defineRoute({
    operationId: 'readDirectorySettings',
    method: 'get',
    path: '/v1/workspaces/{workspaceId}/sso/directory',
    params: workspace,
    access: reading,
    rateLimit: 'authenticated_read',
    cacheControl: 'private, no-store',
    success: {
      status: 200,
      description: 'Safe directory metadata',
      body: projected('DirectorySettings', schemas.directorySettingsSchema),
    },
    problems: sharedProblems1,
  }),
  people: defineRoute({
    operationId: 'listDirectoryPeople',
    method: 'get',
    path: '/v1/workspaces/{workspaceId}/sso/directory/people',
    params: workspace,
    access: reading,
    rateLimit: 'authenticated_read',
    cacheControl: 'private, no-store',
    query: schemas.directoryPeopleQuerySchema,
    success: {
      status: 200,
      description: 'Safe directory metadata',
      body: projected('DirectoryPeoplePage', schemas.directoryPeoplePageSchema),
    },
    problems: sharedProblems1,
  }),
  createCredential: defineRoute({
    ...managementCommand,
    operationId: 'createDirectoryCredential',
    path: '/v1/workspaces/{workspaceId}/sso/directory/credentials',
    params: workspace,
    cacheControl: 'private, no-store',
    body: projected(
      'DirectoryCredentialCreate',
      schemas.directoryCredentialCreateSchema,
    ),
    success: {
      status: 201,
      description: 'Safe directory metadata',
      body: projected(
        'DirectoryCredentialResult',
        schemas.directoryCredentialResultSchema,
      ),
    },
  }),
  revokeCredential: defineRoute({
    ...managementCommand,
    operationId: 'revokeDirectoryCredential',
    path: '/v1/workspaces/{workspaceId}/sso/directory/credentials/{credentialId}/revoke',
    params: workspace.extend({ credentialId: z.uuid() }).strict(),
    cacheControl: 'private, no-store',
    body: projected('DirectoryRevision', schemas.directoryRevisionSchema),
  }),
  mappings: defineRoute({
    ...managementCommand,
    operationId: 'replaceDirectoryMappings',
    method: 'put',
    path: '/v1/workspaces/{workspaceId}/sso/directory/mappings',
    params: workspace,
    cacheControl: 'private, no-store',
    body: projected('DirectoryMappings', schemas.directoryMappingsSchema),
  }),
  adoption: defineRoute({
    operationId: 'previewDirectoryAdoption',
    method: 'get',
    path: '/v1/workspaces/{workspaceId}/sso/directory/adoption',
    params: workspace,
    access: managing,
    rateLimit: 'authenticated_read',
    cacheControl: 'private, no-store',
    query: schemas.directoryAdoptionQuerySchema,
    success: {
      status: 200,
      description: 'Safe directory metadata',
      body: projected(
        'DirectoryAdoptionPreview',
        schemas.directoryAdoptionPreviewSchema,
      ),
    },
    problems: sharedProblems1,
  }),
  adopt: defineRoute({
    ...managementCommand,
    operationId: 'adoptDirectoryMembership',
    path: '/v1/workspaces/{workspaceId}/sso/directory/adopt',
    params: workspace,
    cacheControl: 'private, no-store',
    body: projected('DirectoryAdopt', schemas.directoryAdoptSchema),
  }),
  unlink: defineRoute({
    ...managementCommand,
    operationId: 'unlinkDirectoryWorkspace',
    path: '/v1/workspaces/{workspaceId}/sso/directory/workspaces/{targetWorkspaceId}/unlink',
    params: workspace.extend({ targetWorkspaceId: z.uuid() }).strict(),
    cacheControl: 'private, no-store',
    body: projected('DirectoryRevision', schemas.directoryRevisionSchema),
  }),
};
