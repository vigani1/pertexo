const problem = (status: number, code: string) => ({
  description: code,
  content: { 'application/problem+json': { schema: { type: 'object' } } },
  'x-pertexo-code': code,
  status,
});

export const webhooksClientContract = Object.freeze({
  schemaVersion: 1,
  routes: Object.freeze([
    {
      method: 'GET',
      path: '/v1/workspaces/:workspaceId/workflows/:workflowId/triggers',
    },
    {
      method: 'POST',
      path: '/v1/workspaces/:workspaceId/workflows/:workflowId/triggers/:triggerId/webhook/provision',
      requiredHeaders: ['Idempotency-Key', 'X-CSRF-Token'],
    },
    {
      method: 'POST',
      path: '/v1/workspaces/:workspaceId/workflows/:workflowId/triggers/:triggerId/webhook/rotate-endpoint',
      requiredHeaders: ['Idempotency-Key', 'X-CSRF-Token'],
    },
    {
      method: 'POST',
      path: '/v1/workspaces/:workspaceId/workflows/:workflowId/triggers/:triggerId/webhook/rotate-secret',
      requiredHeaders: ['Idempotency-Key', 'X-CSRF-Token'],
    },
    {
      method: 'POST',
      path: '/hooks/:endpointKey',
      requiredHeaders: [
        'Content-Type',
        'X-Pertexo-Timestamp',
        'X-Pertexo-Signature',
      ],
      maximumBodyBytes: 262_144,
    },
  ]),
});

const managementPath = {
  post: {
    responses: {
      '200': { description: 'Webhook trigger command completed' },
      '400': problem(400, 'request.invalid'),
      '401': problem(401, 'auth.unauthenticated'),
      '404': problem(404, 'resource.not_found'),
      '409': problem(409, 'request.idempotency_conflict'),
    },
  },
};

export const webhooksOpenApiDocument = Object.freeze({
  openapi: '3.1.0',
  info: { title: 'Pertexo Webhooks API', version: '1.0.0' },
  paths: {
    '/v1/workspaces/{workspaceId}/workflows/{workflowId}/triggers': {
      get: {
        responses: { '200': { description: 'Published trigger health' } },
      },
    },
    '/v1/workspaces/{workspaceId}/workflows/{workflowId}/triggers/{triggerId}/webhook/provision':
      managementPath,
    '/v1/workspaces/{workspaceId}/workflows/{workflowId}/triggers/{triggerId}/webhook/rotate-endpoint':
      managementPath,
    '/v1/workspaces/{workspaceId}/workflows/{workflowId}/triggers/{triggerId}/webhook/rotate-secret':
      managementPath,
    '/hooks/{endpointKey}': {
      post: {
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {} } },
        },
        responses: {
          '202': { description: 'Workflow run accepted' },
          '400': problem(400, 'webhook.invalid_json'),
          '401': problem(401, 'webhook.authentication_failed'),
          '409': problem(409, 'webhook.idempotency_conflict'),
          '413': problem(413, 'webhook.payload_too_large'),
          '415': problem(415, 'webhook.unsupported_media_type'),
          '429': problem(429, 'webhook.rate_limited'),
        },
      },
    },
  },
});
