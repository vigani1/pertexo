import { pathParameter, problemResponse } from '../primitives.js';
export const callbackRoutes = ['POST', 'OPTIONS', 'GET', 'HEAD'].map(
  (method) => ({
    method,
    path: '/hooks/:endpointKey/resume',
    ...(method === 'POST' ? { maximumBodyBytes: 262144 } : {}),
  }),
);
const parameters = [
  pathParameter('endpointKey', {
    type: 'string',
    pattern: '^[A-Za-z0-9_-]{43}$',
  }),
];
const problems = {
  '400': problemResponse('Malformed callback input'),
  '401': problemResponse('Non-disclosing authentication failure'),
  '409': problemResponse('Callback already received'),
  '410': problemResponse(
    'Callback expired, consumed, canceled or its run closed',
  ),
  '413': problemResponse('Callback body or retained value exceeds its bounds'),
  '415': problemResponse('Unsupported media type'),
  '429': problemResponse('Callback rate limit'),
  '503': problemResponse('Callback service or rate limiting unavailable'),
};
export const callbackPaths = {
  '/hooks/{endpointKey}/resume': {
    post: {
      operationId: 'respondToCallback',
      security: [],
      parameters,
      description:
        'An unguessable per-run/per-Wait URL accepts one response. Captured Wait configuration may additionally require the existing Pertexo timestamp/raw-body signature or header secret. Body and safe headers become the Wait result. Early responses are retained until the run reaches Wait. Never starts a new run.',
      requestBody: {
        required: false,
        description:
          'At most 256 KiB raw bytes, additionally subject to retained execution value bounds.',
        content: {
          'application/json': { schema: {} },
          'text/plain': { schema: { type: 'string' } },
          'application/x-www-form-urlencoded': {
            schema: {
              type: 'object',
              additionalProperties: { type: 'string' },
            },
          },
        },
      },
      responses: {
        '202': {
          description:
            'Callback accepted once; workflow continuation may still be pending',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { accepted: { type: 'boolean', const: true } },
                required: ['accepted'],
                additionalProperties: false,
              },
            },
          },
        },
        ...problems,
      },
    },
    options: {
      operationId: 'preflightCallback',
      security: [],
      parameters,
      description:
        'Allowed exact browser origins only, in Secret URL or Header secret mode. POST only; no wildcard or credentials. Does not accept a callback or start work.',
      responses: {
        '204': { description: 'Allowed preflight' },
        '401': problems['401'],
        '429': problems['429'],
        '503': problems['503'],
      },
    },
    get: {
      operationId: 'refuseCallbackGet',
      security: [],
      parameters,
      responses: {
        '405': problemResponse('Use POST; probes never resume work'),
      },
    },
    head: {
      operationId: 'refuseCallbackHead',
      security: [],
      parameters,
      responses: {
        '405': problemResponse('Use POST; probes never resume work'),
      },
    },
  },
};
