import { projectContractSchema } from '../schema-projection.js';
import {
  jsonResponse,
  jsonRequest,
  uuidPathParameter,
  csrfHeaderParameter,
  idempotencyHeaderParameter,
  problemResponse,
  queryParameter,
} from '../primitives.js';
import * as directory from '../../schemas/identity/federation/directory.js';
export function directoryContractSchemas(target: 'client' | 'openapi') {
  return Object.fromEntries(
    (
      [
        [
          'DirectoryAdoptionPreview',
          directory.directoryAdoptionPreviewSchema,
          'output',
        ],
        ['DirectorySettings', directory.directorySettingsSchema, 'output'],
        ['DirectoryPeoplePage', directory.directoryPeoplePageSchema, 'output'],
        [
          'DirectoryCredentialCreate',
          directory.directoryCredentialCreateSchema,
          'input',
        ],
        [
          'DirectoryCredentialResult',
          directory.directoryCredentialResultSchema,
          'output',
        ],
        ['DirectoryRevision', directory.directoryRevisionSchema, 'input'],
        ['DirectoryMappings', directory.directoryMappingsSchema, 'input'],
        ['DirectoryAdopt', directory.directoryAdoptSchema, 'input'],
        ['DirectoryChanged', directory.directoryChangedSchema, 'output'],
      ] as const
    ).map(([name, schema, io]) => [
      name,
      projectContractSchema(name, schema, io, target),
    ]),
  );
}
const errors = {
  '400': problemResponse('Invalid directory values or limit reached'),
  '401': problemResponse('Session required'),
  '403': problemResponse('Owner authority or CSRF refused'),
  '404': problemResponse('Directory unavailable'),
  '409': problemResponse('Reviewed settings changed or command conflict'),
  '429': problemResponse('Rate limited'),
  '500': problemResponse('Unexpected failure'),
};
function operation(
  operationId: string,
  response: string,
  request?: string,
  path?: string,
) {
  return {
    operationId,
    security: [{ cookieSession: [] }],
    parameters: [
      uuidPathParameter('workspaceId'),
      ...(path === undefined ? [] : [uuidPathParameter(path)]),
      ...(request === undefined
        ? []
        : [csrfHeaderParameter(), idempotencyHeaderParameter()]),
    ],
    ...(request === undefined ? {} : { requestBody: jsonRequest(request) }),
    responses: {
      '200': jsonResponse('Safe directory metadata', response),
      ...errors,
    },
  };
}
export const directoryContractPaths = {
  '/v1/workspaces/{workspaceId}/sso/directory': {
    get: operation('readDirectorySettings', 'DirectorySettings'),
  },
  '/v1/workspaces/{workspaceId}/sso/directory/people': {
    get: {
      ...operation('listDirectoryPeople', 'DirectoryPeoplePage'),
      parameters: [
        uuidPathParameter('workspaceId'),
        queryParameter(
          'search',
          directory.directoryPeopleQuerySchema.shape.search,
        ),
        queryParameter(
          'after',
          directory.directoryPeopleQuerySchema.shape.after,
        ),
        queryParameter(
          'limit',
          directory.directoryPeopleQuerySchema.shape.limit,
        ),
      ],
    },
  },
  '/v1/workspaces/{workspaceId}/sso/directory/credentials': {
    post: operation(
      'createDirectoryCredential',
      'DirectoryCredentialResult',
      'DirectoryCredentialCreate',
    ),
  },
  '/v1/workspaces/{workspaceId}/sso/directory/credentials/{credentialId}/revoke':
    {
      post: operation(
        'revokeDirectoryCredential',
        'DirectoryChanged',
        'DirectoryRevision',
        'credentialId',
      ),
    },
  '/v1/workspaces/{workspaceId}/sso/directory/mappings': {
    put: operation(
      'replaceDirectoryMappings',
      'DirectoryChanged',
      'DirectoryMappings',
    ),
  },
  '/v1/workspaces/{workspaceId}/sso/directory/adoption': {
    get: {
      ...operation('previewDirectoryAdoption', 'DirectoryAdoptionPreview'),
      parameters: [
        uuidPathParameter('workspaceId'),
        queryParameter(
          'directoryUserId',
          directory.directoryAdoptionQuerySchema.shape.directoryUserId,
          true,
        ),
        queryParameter(
          'targetWorkspaceId',
          directory.directoryAdoptionQuerySchema.shape.targetWorkspaceId,
          true,
        ),
      ],
    },
  },
  '/v1/workspaces/{workspaceId}/sso/directory/adopt': {
    post: operation(
      'adoptDirectoryMembership',
      'DirectoryChanged',
      'DirectoryAdopt',
    ),
  },
  '/v1/workspaces/{workspaceId}/sso/directory/workspaces/{targetWorkspaceId}/unlink':
    {
      post: operation(
        'unlinkDirectoryWorkspace',
        'DirectoryChanged',
        'DirectoryRevision',
        'targetWorkspaceId',
      ),
    },
};
