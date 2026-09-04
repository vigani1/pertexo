export * from './http/schedules.js';

const problem = (status: number, code: string) => ({
  description: code,
  content: { 'application/problem+json': { schema: { type: 'object' } } },
  'x-pertexo-code': code,
  'x-pertexo-status': status,
});

const workspaceParameter = pathParameter('workspaceId');
const workflowParameter = pathParameter('workflowId');
const triggerParameter = pathParameter('triggerId');
const commandParameters = [
  workspaceParameter,
  workflowParameter,
  triggerParameter,
] as const;

function pathParameter(name: string) {
  return {
    name,
    in: 'path',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  } as const;
}

export const schedulesClientContract = Object.freeze({
  schemaVersion: 1,
  routes: Object.freeze([
    {
      method: 'GET',
      path: '/v1/workspaces/:workspaceId/workflows/:workflowId/triggers/schedules',
    },
    {
      method: 'POST',
      path: '/v1/workspaces/:workspaceId/workflows/:workflowId/triggers/:triggerId/schedule/enable',
      requiredHeaders: ['Idempotency-Key', 'X-CSRF-Token'],
    },
    {
      method: 'POST',
      path: '/v1/workspaces/:workspaceId/workflows/:workflowId/triggers/:triggerId/schedule/disable',
      requiredHeaders: ['Idempotency-Key', 'X-CSRF-Token'],
    },
  ]),
});

const command = {
  post: {
    parameters: commandParameters,
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: { type: 'object', additionalProperties: false },
        },
      },
    },
    responses: {
      '200': { description: 'Schedule trigger command completed' },
      '400': problem(400, 'request.invalid'),
      '401': problem(401, 'auth.unauthenticated'),
      '404': problem(404, 'resource.not_found'),
      '409': problem(409, 'request.idempotency_conflict'),
      '428': problem(428, 'request.precondition_required'),
    },
  },
};

export const schedulesOpenApiDocument = Object.freeze({
  openapi: '3.1.0',
  info: { title: 'Pertexo Schedules API', version: '1.0.0' },
  paths: {
    '/v1/workspaces/{workspaceId}/workflows/{workflowId}/triggers/schedules': {
      get: {
        parameters: [workspaceParameter, workflowParameter],
        responses: {
          '200': { description: 'Published schedule trigger health' },
          '401': problem(401, 'auth.unauthenticated'),
          '404': problem(404, 'resource.not_found'),
        },
      },
    },
    '/v1/workspaces/{workspaceId}/workflows/{workflowId}/triggers/{triggerId}/schedule/enable':
      command,
    '/v1/workspaces/{workspaceId}/workflows/{workflowId}/triggers/{triggerId}/schedule/disable':
      command,
  },
});
