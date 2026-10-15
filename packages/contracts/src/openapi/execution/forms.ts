import {
  formSchemaResponseSchema,
  formSubmissionRequestSchema,
  formSubmissionResponseSchema,
  publicFormSubmissionResponseSchema,
  formAccessSchema,
  formAccessRequestSchema,
} from '../../schemas/forms/requests.js';
import {
  jsonSchema,
  jsonRequest,
  jsonResponse,
  uuidPathParameter,
  csrfHeaderParameter,
  idempotencyHeaderParameter,
  responseReference,
  problemResponse,
} from '../primitives.js';
export const formSchemas = {
  FormSchemaResponse: jsonSchema(formSchemaResponseSchema, 'output'),
  FormSubmissionRequest: jsonSchema(formSubmissionRequestSchema, 'input'),
  FormSubmissionResponse: jsonSchema(formSubmissionResponseSchema, 'output'),
  PublicFormSubmissionResponse: jsonSchema(
    publicFormSubmissionResponseSchema,
    'output',
  ),
  FormAccess: jsonSchema(formAccessSchema, 'output'),
  FormAccessRequest: jsonSchema(formAccessRequestSchema, 'input'),
};
const workspace = uuidPathParameter('workspaceId', 'Workspace identifier');
const workflow = uuidPathParameter('workflowId', 'Workflow identifier');
const publicId = uuidPathParameter('publicId', 'Opaque public form identity');
const capability = {
  in: 'header',
  name: 'x-pertexo-form-key',
  required: true,
  description:
    'Capability from the link fragment; session cookies grant no public access.',
  schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
} as const;
const errors = {
  '400': responseReference('BadRequest'),
  '401': responseReference('Unauthenticated'),
  '403': responseReference('Forbidden'),
  '404': responseReference('NotFound'),
  '409': responseReference('Conflict'),
  '429': problemResponse('Rate limit reached'),
  '503': problemResponse('Admission temporarily unavailable'),
  '500': responseReference('Unexpected'),
};
const memberSecurity = [{ cookieSession: [] }];
export const formPaths = {
  '/v1/workspaces/{workspaceId}/workflows/{workflowId}/form': {
    get: {
      operationId: 'getMemberForm',
      security: memberSecurity,
      parameters: [workspace, workflow],
      responses: {
        '200': jsonResponse('Published form schema', 'FormSchemaResponse'),
        ...errors,
      },
    },
  },
  '/v1/workspaces/{workspaceId}/workflows/{workflowId}/form/submit': {
    post: {
      operationId: 'submitMemberForm',
      security: memberSecurity,
      parameters: [
        workspace,
        workflow,
        csrfHeaderParameter(),
        idempotencyHeaderParameter(),
      ],
      requestBody: jsonRequest('FormSubmissionRequest'),
      responses: {
        '200': jsonResponse(
          'Accepted member submission',
          'FormSubmissionResponse',
        ),
        ...errors,
      },
    },
  },
  '/v1/workspaces/{workspaceId}/workflows/{workflowId}/form/access': {
    get: {
      operationId: 'getFormAccess',
      security: memberSecurity,
      parameters: [workspace, workflow],
      responses: {
        '200': jsonResponse(
          'Current link access, without capability material',
          'FormAccess',
        ),
        ...errors,
      },
    },
    post: {
      operationId: 'changeFormAccess',
      security: memberSecurity,
      parameters: [
        workspace,
        workflow,
        csrfHeaderParameter(),
        idempotencyHeaderParameter(),
      ],
      requestBody: jsonRequest('FormAccessRequest'),
      responses: {
        '200': jsonResponse('Recorded access revision', 'FormAccess'),
        ...errors,
      },
    },
  },
  '/v1/forms/{publicId}': {
    get: {
      operationId: 'getPublicForm',
      security: [],
      parameters: [publicId, capability],
      responses: {
        '200': jsonResponse('Public field schema only', 'FormSchemaResponse'),
        ...errors,
      },
    },
  },
  '/v1/forms/{publicId}/submit': {
    post: {
      operationId: 'submitPublicForm',
      security: [],
      parameters: [publicId, capability, idempotencyHeaderParameter()],
      requestBody: jsonRequest('FormSubmissionRequest'),
      responses: {
        '200': jsonResponse(
          'Acceptance only; no run identity or data',
          'PublicFormSubmissionResponse',
        ),
        ...errors,
      },
    },
  },
};
