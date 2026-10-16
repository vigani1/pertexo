import {
  stepSampleListResponseSchema,
  stepSampleResponseSchema,
  stepSampleWriteRequestSchema,
  stepSampleDeleteRequestSchema,
  stepSampleCommandResponseSchema,
} from '../../schemas/workflows/step-samples.js';
import {
  csrfHeaderParameter,
  idempotencyHeaderParameter,
  jsonRequest,
  jsonResponse,
  responseReference,
  uuidPathParameter,
  jsonSchema,
} from '../primitives.js';
import { projectContractSchema } from '../schema-projection.js';
import { z } from 'zod';

export function stepSampleContractSchemas(target: 'client' | 'openapi') {
  const schemas = {
    StepSampleListResponse: stepSampleListResponseSchema,
    StepSampleResponse: stepSampleResponseSchema,
    StepSampleWriteRequest: stepSampleWriteRequestSchema,
    StepSampleDeleteRequest: stepSampleDeleteRequestSchema,
    StepSampleCommandResponse: stepSampleCommandResponseSchema,
  };
  return Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => [
      name,
      projectContractSchema(
        name,
        schema,
        name.endsWith('Request') ? 'input' : 'output',
        target,
      ),
    ]),
  );
}
const scope = [
  uuidPathParameter('workspaceId', 'Workspace identifier'),
  uuidPathParameter('workflowId', 'Workflow identifier'),
];
const node = {
  ...uuidPathParameter('nodeId', 'Draft step identifier'),
  schema: jsonSchema(z.string().min(1).max(256), 'input'),
};
const errors = {
  '400': responseReference('BadRequest'),
  '401': responseReference('Unauthenticated'),
  '403': responseReference('Forbidden'),
  '404': responseReference('NotFound'),
  '409': responseReference('Conflict'),
  '500': responseReference('Unexpected'),
};
export const stepSamplePaths = {
  '/v1/workspaces/{workspaceId}/workflows/{workflowId}/draft/samples': {
    get: {
      operationId: 'listStepSamples',
      security: [{ cookieSession: [] }],
      parameters: scope,
      responses: {
        '200': jsonResponse(
          'Pinned step metadata, without output payloads',
          'StepSampleListResponse',
        ),
        ...errors,
      },
    },
  },
  '/v1/workspaces/{workspaceId}/workflows/{workflowId}/draft/nodes/{nodeId}/sample':
    {
      get: {
        operationId: 'getStepSample',
        security: [{ cookieSession: [] }],
        parameters: [...scope, node],
        responses: {
          '200': jsonResponse(
            'One pinned sample and its retained value',
            'StepSampleResponse',
          ),
          ...errors,
        },
      },
      put: {
        operationId: 'putStepSample',
        security: [{ cookieSession: [] }],
        parameters: [
          ...scope,
          node,
          csrfHeaderParameter(),
          idempotencyHeaderParameter(),
        ],
        requestBody: jsonRequest('StepSampleWriteRequest'),
        responses: {
          '200': jsonResponse(
            'Saved or confirmed sample identity',
            'StepSampleCommandResponse',
          ),
          ...errors,
        },
      },
      delete: {
        operationId: 'removeStepSample',
        security: [{ cookieSession: [] }],
        parameters: [
          ...scope,
          node,
          csrfHeaderParameter(),
          idempotencyHeaderParameter(),
        ],
        requestBody: jsonRequest('StepSampleDeleteRequest'),
        responses: {
          '200': jsonResponse(
            'Removed sample identity',
            'StepSampleCommandResponse',
          ),
          ...errors,
        },
      },
    },
};
