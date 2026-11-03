import {
  ACTIVE_WORKSPACE_STATUSES,
  BROWSABLE_WORKSPACE_STATUSES,
} from '@pertexo/policy';
import { z } from 'zod';

import { problemResponse } from '../../openapi/primitives.js';
import {
  noticeCommandResponseSchema,
  noticeDefaultsRequestSchema,
  noticeOneClickQuerySchema,
  noticePreferencesRequestSchema,
  noticePreferencesResponseSchema,
  noticeSubjectParamsSchema,
  noticeSubscriptionRequestSchema,
  noticeSubscriptionSchema,
  noticeUnsubscribeResponseSchema,
} from '../../schemas/notifications/preferences.js';
import { defineRoute, named, type RouteAccess } from '../define.js';

const ROOT = '/v1/workspaces/{workspaceId}/notifications';
const workspace = z.object({ workspaceId: z.uuid() });
const reading: RouteAccess = {
  auth: 'session',
  capabilities: [
    {
      name: 'workspace:read',
      statuses: BROWSABLE_WORKSPACE_STATUSES,
      disclosure: 'not_found',
    },
  ],
};
const changing: RouteAccess = {
  auth: 'session',
  capabilities: [
    {
      name: 'workspace:read',
      statuses: ACTIVE_WORKSPACE_STATUSES,
      disclosure: 'not_found',
    },
  ],
};
const problems = {
  '400': problemResponse('Invalid request'),
  '401': problemResponse('Session required'),
  '403': problemResponse('CSRF refused'),
  '404': problemResponse('Workspace, subject or link unavailable'),
  '409': problemResponse('Choices changed or email unavailable'),
  '429': problemResponse('Rate limited'),
  '500': problemResponse('Unexpected failure'),
};
const session = { cacheControl: 'private, no-store', problems } as const;
const command = (description: string) => ({
  status: 200,
  description,
  body: named('NoticeCommandResponse', noticeCommandResponseSchema),
});
const unsubscribed = {
  status: 200,
  description: 'Personal email is Off',
  body: named('NoticeUnsubscribeResponse', noticeUnsubscribeResponseSchema),
};

export const notificationPreferenceRoutes = {
  read: defineRoute({
    ...session,
    operationId: 'getNotificationPreferences',
    method: 'get',
    path: `${ROOT}/preferences`,
    params: workspace,
    access: reading,
    rateLimit: 'authenticated_read',
    success: {
      status: 200,
      description: 'Personal choices, effective schedule and availability',
      body: named('NoticePreferencesResponse', noticePreferencesResponseSchema),
    },
  }),
  replace: defineRoute({
    ...session,
    operationId: 'replaceNotificationPreferences',
    method: 'put',
    path: `${ROOT}/preferences`,
    params: workspace,
    access: changing,
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    body: named('NoticePreferencesRequest', noticePreferencesRequestSchema),
    success: command('Exact personal preference command'),
  }),
  defaults: defineRoute({
    ...session,
    operationId: 'replaceNotificationDefaults',
    description: 'Owners/admins with notification:manage_defaults only.',
    method: 'put',
    path: `${ROOT}/defaults`,
    params: workspace,
    access: changing,
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    body: named('NoticeDefaultsRequest', noticeDefaultsRequestSchema),
    success: command('Exact workspace default command'),
  }),
  subscription: defineRoute({
    ...session,
    operationId: 'getNotificationSubscription',
    method: 'get',
    path: `${ROOT}/subjects/{subjectKind}/{subjectId}`,
    params: noticeSubjectParamsSchema,
    access: reading,
    rateLimit: 'authenticated_read',
    success: {
      status: 200,
      description: 'Private follow/mute state',
      body: named('NoticeSubscription', noticeSubscriptionSchema),
    },
  }),
  replaceSubscription: defineRoute({
    ...session,
    operationId: 'replaceNotificationSubscription',
    method: 'put',
    path: `${ROOT}/subjects/{subjectKind}/{subjectId}`,
    params: noticeSubjectParamsSchema,
    access: changing,
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    body: named('NoticeSubscriptionRequest', noticeSubscriptionRequestSchema),
    success: command('Exact subject choice command'),
  }),
  confirmOneClick: defineRoute({
    operationId: 'confirmOneClickNotificationUnsubscribe',
    description:
      'Manual clients only: non-mutating redirect to the existing same-origin confirmation page.',
    method: 'get',
    path: '/v1/notifications/unsubscribe/one-click',
    query: noticeOneClickQuerySchema,
    access: { auth: 'public' },
    rateLimit: 'notice_unsubscribe',
    success: {
      status: 303,
      redirect: true,
      response: {
        description: 'Open confirmation without changing email',
        headers: { Location: { required: true, schema: { type: 'string' } } },
      },
    },
    problems: {
      '400': problems['400'],
      '429': problems['429'],
      default: problemResponse('Unexpected or unavailable service'),
    },
  }),
  oneClick: defineRoute({
    operationId: 'oneClickNotificationUnsubscribe',
    description:
      'RFC 8058 capability-authorized opt-out. The URL token authorizes the request. Form contents are ignored within 8 KiB. No session, cookies, CSRF header or redirect. Only turns personal email Off.',
    method: 'post',
    path: '/v1/notifications/unsubscribe/one-click',
    query: noticeOneClickQuerySchema,
    access: { auth: 'public' },
    rateLimit: 'notice_unsubscribe',
    requestDocument: {
      required: false,
      description:
        'Opaque body, ignored. Mail clients normally send List-Unsubscribe=One-Click. Maximum 8 KiB.',
      content: {
        'application/x-www-form-urlencoded': { schema: {} },
        'multipart/form-data': { schema: {} },
      },
    },
    success: unsubscribed,
    problems: {
      '400': problems['400'],
      '404': problems['404'],
      '413': problemResponse('Form exceeds 8 KiB'),
      '415': problemResponse('Expected a standard form MIME type'),
      '429': problems['429'],
      '500': problems['500'],
    },
  }),
  unsubscribe: defineRoute({
    operationId: 'unsubscribeNotificationEmail',
    description:
      'Inert confirmation page GET; only explicit capability-authorized POST changes email to Off. No sign-in or approval decision.',
    method: 'post',
    path: '/v1/notifications/unsubscribe',
    headers: z.object({
      'x-pertexo-unsubscribe-key': z.string().min(1).max(4096),
    }),
    access: { auth: 'public' },
    rateLimit: 'notice_unsubscribe',
    cacheControl: 'no-store',
    responseHeaders: { 'Referrer-Policy': 'no-referrer' },
    body: named('NoticeUnsubscribeRequest', z.object({}).strict()),
    success: unsubscribed,
    problems,
  }),
};
