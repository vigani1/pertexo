import {
  formFinalizeUploadRequestSchema,
  formUploadRequestSchema,
  formUploadResponseSchema,
  formUploadSchema,
  taskUploadRequestSchema,
} from '../../schemas/forms/uploads.js';
import {
  csrfHeaderParameter,
  idempotencyHeaderParameter,
  jsonRequest,
  jsonResponse,
  jsonSchema,
  problemResponse,
  responseReference,
  uuidPathParameter,
} from '../primitives.js';

export const formUploadSchemas = {
  FormUploadRequest: jsonSchema(formUploadRequestSchema, 'input'),
  TaskUploadRequest: jsonSchema(taskUploadRequestSchema, 'input'),
  FormFinalizeUploadRequest: jsonSchema(
    formFinalizeUploadRequestSchema,
    'input',
  ),
  FormUploadResponse: jsonSchema(formUploadResponseSchema, 'output'),
  FormUpload: jsonSchema(formUploadSchema, 'output'),
};
const session = {
  in: 'header',
  name: 'x-pertexo-form-session',
  required: true,
  description:
    'Random token for one response. A submission can use only uploads begun with the same token.',
  schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
} as const;
const capability = {
  in: 'header',
  name: 'x-pertexo-form-key',
  required: true,
  description: 'Capability from the public link fragment.',
  schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
} as const;
const upload = uuidPathParameter('uploadId', 'Upload (file) identifier');
const scopes = {
  public: {
    path: '/v1/forms/{publicId}/uploads',
    name: 'PublicForm',
    security: [],
    parameters: [
      uuidPathParameter('publicId', 'Opaque public form identity'),
      capability,
    ],
    request: 'FormUploadRequest',
  },
  member: {
    path: '/v1/workspaces/{workspaceId}/workflows/{workflowId}/form/uploads',
    name: 'MemberForm',
    security: [{ cookieSession: [] }],
    parameters: [
      uuidPathParameter('workspaceId', 'Workspace identifier'),
      uuidPathParameter('workflowId', 'Workflow identifier'),
      csrfHeaderParameter(),
    ],
    request: 'FormUploadRequest',
  },
  task: {
    path: '/v1/workspaces/{workspaceId}/pending-tasks/{taskId}/uploads',
    name: 'InputRequest',
    security: [{ cookieSession: [] }],
    parameters: [
      uuidPathParameter('workspaceId', 'Workspace identifier'),
      uuidPathParameter('taskId', 'Pending task identifier'),
      csrfHeaderParameter(),
    ],
    request: 'TaskUploadRequest',
  },
} as const;
const errors = {
  '400': responseReference('BadRequest'),
  '401': responseReference('Unauthenticated'),
  '404': responseReference('NotFound'),
  '409': responseReference('Conflict'),
  '413': problemResponse('The file is larger than the field allows'),
  '415': problemResponse('The file type is not accepted by the field'),
  '429': problemResponse('Rate or upload limit reached'),
  '503': problemResponse('File storage unavailable'),
  '500': responseReference('Unexpected'),
};

export const formUploadPaths: Readonly<Record<string, unknown>> =
  Object.fromEntries(
    Object.values(scopes).flatMap((scope): [string, unknown][] => [
      [
        scope.path,
        {
          post: {
            operationId: `begin${scope.name}Upload`,
            security: scope.security,
            parameters: [
              ...scope.parameters,
              session,
              idempotencyHeaderParameter(),
            ],
            requestBody: jsonRequest(scope.request),
            responses: {
              '201': jsonResponse(
                'Pending upload bound to this response, with a short-lived PUT capability',
                'FormUploadResponse',
              ),
              ...errors,
            },
          },
        },
      ],
      [
        `${scope.path}/{uploadId}/finalize`,
        {
          post: {
            operationId: `finalize${scope.name}Upload`,
            security: scope.security,
            parameters: [...scope.parameters, upload, session],
            requestBody: jsonRequest('FormFinalizeUploadRequest'),
            responses: {
              '200': jsonResponse(
                'Verified file, kept for a day unless a submission uses it',
                'FormUpload',
              ),
              ...errors,
            },
          },
        },
      ],
    ]),
  );
