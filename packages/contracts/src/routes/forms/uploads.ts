import { z } from 'zod';

import {
  problemResponse,
  responseReference,
} from '../openapi-primitives.js';
import {
  formFinalizeUploadRequestSchema,
  formUploadRequestSchema,
  formUploadResponseSchema,
  formUploadSchema,
  memberFormUploadParamsSchema,
  publicFormUploadParamsSchema,
  taskUploadParamsSchema,
  taskUploadRequestSchema,
  taskUploadsParamsSchema,
} from '../../schemas/forms/uploads.js';
import {
  formParamsSchema,
  publicFormParamsSchema,
} from '../../schemas/forms/requests.js';
import { defineRoute, named, type RouteAccess } from '../define.js';
import {
  capabilityHeader,
  publicAnswer,
  responding,
  session,
  sessionHeader,
} from './access.js';

const problems = {
  '400': responseReference('BadRequest'),
  '401': responseReference('Unauthenticated'),
  '404': responseReference('NotFound'),
  '409': responseReference('Conflict'),
  '413': problemResponse('The file is larger than the field allows'),
  '415': problemResponse('The file type is not accepted by the field'),
  '429': problemResponse('Rate or upload limit reached'),
  '503': problemResponse('File storage unavailable'),
  '500': responseReference('Unexpected'),
};
const begun = {
  status: 201,
  description:
    'Pending upload bound to this response, with a short-lived PUT capability',
  body: named('FormUploadResponse', formUploadResponseSchema),
};
const finalized = {
  status: 200,
  description: 'Verified file, kept for a day unless a submission uses it',
  body: named('FormUpload', formUploadSchema),
};
const finalize = named(
  'FormFinalizeUploadRequest',
  formFinalizeUploadRequestSchema,
);
const formUpload = named('FormUploadRequest', formUploadRequestSchema);
const responseSession = z.object({ 'x-pertexo-form-session': sessionHeader });
const publicResponder = responseSession.extend({
  'x-pertexo-form-key': capabilityHeader,
});
/** Task eligibility is rechecked per upload; this admits members who may read runs. */
const taskResponder: RouteAccess = session('run:read');

/** Uploads begun for one response, by link, as a member, or on an input request task. */
export const formUploadRoutes = {
  publicBegin: defineRoute({
    operationId: 'beginPublicFormUpload',
    method: 'post',
    path: '/v1/forms/{publicId}/uploads',
    params: publicFormParamsSchema,
    headers: publicResponder,
    access: { auth: 'public' },
    rateLimit: 'form_read',
    idempotent: true,
    ...publicAnswer,
    body: formUpload,
    success: begun,
    problems,
  }),
  publicFinalize: defineRoute({
    operationId: 'finalizePublicFormUpload',
    method: 'post',
    path: '/v1/forms/{publicId}/uploads/{uploadId}/finalize',
    params: publicFormUploadParamsSchema,
    headers: publicResponder,
    access: { auth: 'public' },
    rateLimit: 'form_read',
    ...publicAnswer,
    body: finalize,
    success: finalized,
    problems,
  }),
  memberBegin: defineRoute({
    operationId: 'beginMemberFormUpload',
    method: 'post',
    path: '/v1/workspaces/{workspaceId}/workflows/{workflowId}/form/uploads',
    params: formParamsSchema,
    headers: responseSession,
    access: responding,
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    cacheControl: 'private, no-store',
    body: formUpload,
    success: begun,
    problems,
  }),
  memberFinalize: defineRoute({
    operationId: 'finalizeMemberFormUpload',
    method: 'post',
    path: '/v1/workspaces/{workspaceId}/workflows/{workflowId}/form/uploads/{uploadId}/finalize',
    params: memberFormUploadParamsSchema,
    headers: responseSession,
    access: responding,
    rateLimit: 'ordinary_mutation',
    cacheControl: 'private, no-store',
    body: finalize,
    success: finalized,
    problems,
  }),
  taskBegin: defineRoute({
    operationId: 'beginInputRequestUpload',
    method: 'post',
    path: '/v1/workspaces/{workspaceId}/pending-tasks/{taskId}/uploads',
    params: taskUploadsParamsSchema,
    headers: responseSession,
    access: taskResponder,
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    cacheControl: 'private, no-store',
    body: named('TaskUploadRequest', taskUploadRequestSchema),
    success: begun,
    problems,
  }),
  taskFinalize: defineRoute({
    operationId: 'finalizeInputRequestUpload',
    method: 'post',
    path: '/v1/workspaces/{workspaceId}/pending-tasks/{taskId}/uploads/{uploadId}/finalize',
    params: taskUploadParamsSchema,
    headers: responseSession,
    access: taskResponder,
    rateLimit: 'ordinary_mutation',
    cacheControl: 'private, no-store',
    body: finalize,
    success: finalized,
    problems,
  }),
};
