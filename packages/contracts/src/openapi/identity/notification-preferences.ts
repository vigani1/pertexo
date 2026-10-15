import {
  noticePreferencesResponseSchema,
  noticePreferencesRequestSchema,
  noticeDefaultsRequestSchema,
  noticeSubscriptionSchema,
  noticeSubscriptionRequestSchema,
  noticeCommandResponseSchema,
  noticeUnsubscribeResponseSchema,
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
