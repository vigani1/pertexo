import {
  noticePreferencesResponseSchema,
  noticePreferencesRequestSchema,
  noticeDefaultsRequestSchema,
  noticeSubscriptionSchema,
  noticeSubscriptionRequestSchema,
  noticeCommandResponseSchema,
  noticeUnsubscribeResponseSchema,
  noticeOneClickQuerySchema,
} from '../../schemas/notifications/preferences.js';
import {
  jsonSchema,
  jsonResponse,
  jsonRequest,
  uuidPathParameter,
  csrfHeaderParameter,
  idempotencyHeaderParameter,
  problemResponse,
} from '../primitives.js';
const scope = [uuidPathParameter('workspaceId')];
const problems = {
  '400': problemResponse('Invalid request'),
  '401': problemResponse('Session required'),
  '403': problemResponse('CSRF refused'),
  '404': problemResponse('Workspace, subject or link unavailable'),
  '409': problemResponse('Choices changed or email unavailable'),
  '429': problemResponse('Rate limited'),
  '500': problemResponse('Unexpected failure'),
};
const commandParameters = [
  ...scope,
  csrfHeaderParameter(),
  idempotencyHeaderParameter(),
];
const security = [{ cookieSession: [] }];
export const notificationPreferenceSchemas = {
  NoticePreferencesResponse: jsonSchema(
    noticePreferencesResponseSchema,
    'output',
  ),
  NoticePreferencesRequest: jsonSchema(noticePreferencesRequestSchema, 'input'),
  NoticeDefaultsRequest: jsonSchema(noticeDefaultsRequestSchema, 'input'),
  NoticeSubscription: jsonSchema(noticeSubscriptionSchema, 'output'),
  NoticeSubscriptionRequest: jsonSchema(
    noticeSubscriptionRequestSchema,
    'input',
  ),
  NoticeCommandResponse: jsonSchema(noticeCommandResponseSchema, 'output'),
  NoticeUnsubscribeResponse: jsonSchema(
    noticeUnsubscribeResponseSchema,
    'output',
  ),
};
export const notificationPreferencePaths = {
  '/v1/workspaces/{workspaceId}/notifications/preferences': {
    get: {
      operationId: 'getNotificationPreferences',
      security,
      parameters: scope,
      responses: {
        '200': jsonResponse(
          'Personal choices, effective schedule and availability',
          'NoticePreferencesResponse',
        ),
        ...problems,
      },
    },
    put: {
      operationId: 'replaceNotificationPreferences',
      security,
      parameters: commandParameters,
      requestBody: jsonRequest('NoticePreferencesRequest'),
      responses: {
        '200': jsonResponse(
          'Exact personal preference command',
          'NoticeCommandResponse',
        ),
        ...problems,
      },
    },
  },
  '/v1/workspaces/{workspaceId}/notifications/defaults': {
    put: {
      operationId: 'replaceNotificationDefaults',
      description: 'Owners/admins with notification:manage_defaults only.',
      security,
      parameters: commandParameters,
      requestBody: jsonRequest('NoticeDefaultsRequest'),
      responses: {
        '200': jsonResponse(
          'Exact workspace default command',
          'NoticeCommandResponse',
        ),
        ...problems,
      },
    },
  },
  '/v1/workspaces/{workspaceId}/notifications/subjects/{subjectKind}/{subjectId}':
    {
      get: {
        operationId: 'getNotificationSubscription',
        security,
        parameters: [
          ...scope,
          {
            in: 'path',
            name: 'subjectKind',
            required: true,
            schema: { type: 'string', enum: ['workflow', 'connection'] },
          },
          uuidPathParameter('subjectId'),
        ],
        responses: {
          '200': jsonResponse(
            'Private follow/mute state',
            'NoticeSubscription',
          ),
          ...problems,
        },
      },
      put: {
        operationId: 'replaceNotificationSubscription',
        security,
        parameters: [
          ...commandParameters,
          {
            in: 'path',
            name: 'subjectKind',
            required: true,
            schema: { type: 'string', enum: ['workflow', 'connection'] },
          },
          uuidPathParameter('subjectId'),
        ],
        requestBody: jsonRequest('NoticeSubscriptionRequest'),
        responses: {
          '200': jsonResponse(
            'Exact subject choice command',
            'NoticeCommandResponse',
          ),
          ...problems,
        },
      },
    },
  '/v1/notifications/unsubscribe/one-click': {
    get: {
      operationId: 'confirmOneClickNotificationUnsubscribe',
      description:
        'Manual clients only: non-mutating redirect to the existing same-origin confirmation page.',
      security: [],
      parameters: [
        {
          in: 'query',
          name: 'token',
          required: true,
          schema: jsonSchema(noticeOneClickQuerySchema.shape.token, 'input'),
        },
      ],
      responses: {
        '303': {
          description: 'Open confirmation without changing email',
          headers: { Location: { required: true, schema: { type: 'string' } } },
        },
        '400': problems['400'],
        '429': problems['429'],
        default: problemResponse('Unexpected or unavailable service'),
      },
    },
    post: {
      operationId: 'oneClickNotificationUnsubscribe',
      description:
        'RFC 8058 capability-authorized opt-out. The URL token authorizes the request. Form contents are ignored within 8 KiB. No session, cookies, CSRF header or redirect. Only turns personal email Off.',
      security: [],
      parameters: [
        {
          in: 'query',
          name: 'token',
          required: true,
          schema: jsonSchema(noticeOneClickQuerySchema.shape.token, 'input'),
        },
      ],
      requestBody: {
        required: false,
        description:
          'Opaque body, ignored. Mail clients normally send List-Unsubscribe=One-Click. Maximum 8 KiB.',
        content: {
          'application/x-www-form-urlencoded': { schema: {} },
          'multipart/form-data': { schema: {} },
        },
      },
      responses: {
        '200': jsonResponse(
          'Personal email is Off',
          'NoticeUnsubscribeResponse',
        ),
        '400': problems['400'],
        '404': problems['404'],
        '413': problemResponse('Form exceeds 8 KiB'),
        '415': problemResponse('Expected a standard form MIME type'),
        '429': problems['429'],
        '500': problems['500'],
      },
    },
  },
  '/v1/notifications/unsubscribe': {
    post: {
      operationId: 'unsubscribeNotificationEmail',
      description:
        'Inert confirmation page GET; only explicit capability-authorized POST changes email to Off. No sign-in or approval decision.',
      security: [],
      parameters: [
        {
          in: 'header',
          name: 'X-Pertexo-Unsubscribe-Key',
          required: true,
          schema: { type: 'string', minLength: 1, maxLength: 4096 },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { type: 'object', additionalProperties: false },
          },
        },
      },
      responses: {
        '200': jsonResponse(
          'Personal email is Off',
          'NoticeUnsubscribeResponse',
        ),
        ...problems,
      },
    },
  },
};
export const notificationPreferenceRoutes = [
  { method: 'GET', path: '/v1/notifications/unsubscribe/one-click' },
  { method: 'POST', path: '/v1/notifications/unsubscribe/one-click' },
  {
    method: 'GET',
    path: '/v1/workspaces/:workspaceId/notifications/preferences',
  },
  {
    method: 'PUT',
    path: '/v1/workspaces/:workspaceId/notifications/preferences',
    requiredHeaders: ['X-CSRF-Token', 'Idempotency-Key'],
  },
  {
    method: 'PUT',
    path: '/v1/workspaces/:workspaceId/notifications/defaults',
    requiredHeaders: ['X-CSRF-Token', 'Idempotency-Key'],
  },
  {
    method: 'GET',
    path: '/v1/workspaces/:workspaceId/notifications/subjects/:subjectKind/:subjectId',
  },
  {
    method: 'PUT',
    path: '/v1/workspaces/:workspaceId/notifications/subjects/:subjectKind/:subjectId',
    requiredHeaders: ['X-CSRF-Token', 'Idempotency-Key'],
  },
  {
    method: 'POST',
    path: '/v1/notifications/unsubscribe',
    requiredHeaders: ['X-Pertexo-Unsubscribe-Key'],
  },
] as const;
