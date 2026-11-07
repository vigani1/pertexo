import { workflowIdParamSchema } from '../../schemas/workflows/authoring.js';
import * as schemas from '../../schemas/workflows/input-cases.js';
import { jsonSchema, responseReference } from '../openapi-primitives.js';
import { defineRoute } from '../define.js';
import {
  problems,
  projected,
  readProblems,
  reading,
  updating,
  WORKFLOW,
} from './access.js';

const CASES = `${WORKFLOW}/input-cases` as const;
const ONE = `${CASES}/{caseId}` as const;
const noStore = 'private, no-store';
const commandProblems = problems('400', '401', '403', '404', '500', '409');
const conditionalProblems = {
  ...commandProblems,
  '428': responseReference('PreconditionRequired'),
  '412': {
    description:
      'Run-input case representation changed; refetch and deliberately confirm a new command',
    content: {
      'application/problem+json': {
        schema: { $ref: '#/components/schemas/ApiProblem' },
      },
    },
  },
};
const precondition = {
  description: 'One strong opaque run-input case representation validator',
  schema: schemas.workflowInputCaseTagSchema,
};
const receipt = (description: string) => ({
  status: 200,
  description,
  body: projected(
    'WorkflowInputCaseCommandResponse',
    schemas.workflowInputCaseCommandResponseSchema,
  ),
});

export const inputCaseRoutes = {
  list: defineRoute({
    operationId: 'listWorkflowInputCases',
    method: 'get',
    path: CASES,
    params: workflowIdParamSchema,
    query: schemas.workflowInputCaseQuerySchema,
    access: reading,
    rateLimit: 'authenticated_read',
    cacheControl: noStore,
    description:
      'List shared version-contextual case metadata only. Requires current workflow:read; no-store. Loading never starts a run.',
    success: {
      status: 200,
      description: 'Bounded case metadata page',
      body: projected(
        'WorkflowInputCaseListResponse',
        schemas.workflowInputCaseListResponseSchema,
      ),
    },
    problems: readProblems,
  }),
  create: defineRoute({
    operationId: 'createWorkflowInputCase',
    method: 'post',
    path: CASES,
    params: workflowIdParamSchema,
    access: updating,
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    cacheControl: noStore,
    description:
      'Create a manually entered synthetic run-input case bound to a retained published version. Requires workflow:update; never runs a workflow. Exact retries recover the original identifiers for 24 hours.',
    body: projected(
      'WorkflowInputCaseCreateRequest',
      schemas.workflowInputCaseCreateRequestSchema,
    ),
    success: {
      ...receipt(
        'Original case identifiers; fetch current representation separately',
      ),
      status: 201,
    },
    problems: commandProblems,
  }),
  get: defineRoute({
    operationId: 'getWorkflowInputCase',
    method: 'get',
    path: ONE,
    params: schemas.workflowInputCaseParamSchema,
    access: reading,
    rateLimit: 'authenticated_read',
    cacheControl: noStore,
    description:
      'Read one current case payload with workflow:read. Deleted cases cannot be loaded; previously copied input is detached. No-store.',
    success: {
      status: 200,
      description: 'Current case and bounded JSON',
      body: projected(
        'WorkflowInputCaseResponse',
        schemas.workflowInputCaseResponseSchema,
      ),
      headers: {
        ETag: {
          description: 'Strong opaque current case validator',
          required: true,
          schema: jsonSchema(schemas.workflowInputCaseTagSchema, 'output'),
        },
      },
    },
    problems: readProblems,
  }),
  update: defineRoute({
    operationId: 'updateWorkflowInputCase',
    method: 'put',
    path: ONE,
    params: schemas.workflowInputCaseParamSchema,
    access: updating,
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    precondition,
    cacheControl: noStore,
    description:
      'Update name/input without rebinding version. Requires workflow:update and strong If-Match. Current authority and retained exact recovery precede CAS. Receipt contains identifiers only.',
    body: projected(
      'WorkflowInputCaseUpdateRequest',
      schemas.workflowInputCaseUpdateRequestSchema,
    ),
    success: receipt('Original committed identifiers'),
    problems: conditionalProblems,
  }),
  delete: defineRoute({
    operationId: 'deleteWorkflowInputCase',
    method: 'delete',
    path: ONE,
    params: schemas.workflowInputCaseParamSchema,
    access: updating,
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    precondition,
    cacheControl: noStore,
    description:
      'Logically hide a case; held payload bytes remain charged until physical erasure. Requires workflow:update and strong If-Match. Exact retry never resurrects a deleted case.',
    success: receipt('Original deletion identifiers'),
    problems: conditionalProblems,
  }),
};
