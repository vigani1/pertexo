import {
  pathParameter,
  responseReference,
} from '../../routes/openapi-primitives.js';

/** Capture through a draft's temporary test URL, outside Nest; the listener's own routes are declared. */
const ingress = {
  parameters: [
    pathParameter('endpointKey', {
      type: 'string',
      pattern: '^[A-Za-z0-9_-]{43}$',
    }),
  ],
  responses: {
    '202': {
      description: 'One authenticated request captured, no workflow execution',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: { captured: { const: true } },
            required: ['captured'],
            additionalProperties: false,
          },
        },
      },
    },
    '401': responseReference('Unauthenticated'),
    '400': responseReference('BadRequest'),
    '413': responseReference('PayloadTooLarge'),
    '415': responseReference('UnsupportedMediaType'),
    '429': responseReference('RateLimited'),
    '503': responseReference('Unavailable'),
  },
};
export const testEventPaths = {
  '/hooks/{endpointKey}/test': {
    get: { ...ingress, operationId: 'captureWebhookTestGet' },
    post: {
      ...ingress,
      operationId: 'captureWebhookTestPost',
      requestBody: {
        required: false,
        content: {
          'application/json': { schema: {} },
          'application/x-www-form-urlencoded': { schema: { type: 'string' } },
          'text/plain': { schema: { type: 'string' } },
        },
      },
    },
    options: {
      operationId: 'preflightWebhookTestEvent',
      parameters: ingress.parameters,
      responses: {
        '204': {
          description:
            'Exact listed browser origin only, no credentials and no capture',
        },
        '401': responseReference('Unauthenticated'),
        '429': responseReference('RateLimited'),
        '503': responseReference('Unavailable'),
      },
    },
  },
};
