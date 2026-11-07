import { z } from 'zod';

import { problemResponse, responseReference } from '../openapi-primitives.js';
import {
  coordinatedEventHistoryQuerySchema,
  coordinatedEventHistorySchema,
} from '../../schemas/forms/coordination.js';
import {
  formAccessRequestSchema,
  formAccessSchema,
  formParamsSchema,
  formSchemaResponseSchema,
  formSubmissionRequestSchema,
  formSubmissionResponseSchema,
  publicFormParamsSchema,
  publicFormSubmissionResponseSchema,
} from '../../schemas/forms/requests.js';
import { defineRoute, named } from '../define.js';
import {
  capabilityHeader,
  managing,
  publicAnswer,
  readingAsManager,
  readingForm,
  responding,
  sessionHeader,
} from './access.js';

const FORM = '/v1/workspaces/{workspaceId}/workflows/{workflowId}/form';
const PUBLIC = '/v1/forms/{publicId}';
const formProblems = {
  '400': responseReference('BadRequest'),
  '401': responseReference('Unauthenticated'),
  '403': responseReference('Forbidden'),
  '404': responseReference('NotFound'),
  '409': responseReference('Conflict'),
  '429': problemResponse('Rate limit reached'),
  '503': problemResponse('Admission temporarily unavailable'),
  '500': responseReference('Unexpected'),
};
const noStore = 'private, no-store';
const schema = named('FormSchemaResponse', formSchemaResponseSchema);
const submission = named('FormSubmissionRequest', formSubmissionRequestSchema);
const access = named('FormAccess', formAccessSchema);
/** Names the response session only when the answers reference uploads. */
const submitHeaders = z.object({
  'x-pertexo-form-session': sessionHeader.optional(),
});

export const formRoutes = {
  events: defineRoute({
    operationId: 'listCoordinatedFormEvents',
    method: 'get',
    path: `${FORM}/events`,
    params: formParamsSchema,
    query: coordinatedEventHistoryQuerySchema,
    access: readingAsManager,
    rateLimit: 'authenticated_read',
    cacheControl: noStore,
    success: {
      status: 200,
      description: 'Metadata-only form event history',
      body: named('CoordinatedEventHistory', coordinatedEventHistorySchema),
    },
    problems: formProblems,
  }),
  read: defineRoute({
    operationId: 'getMemberForm',
    method: 'get',
    path: FORM,
    params: formParamsSchema,
    access: readingForm,
    rateLimit: 'authenticated_read',
    cacheControl: noStore,
    success: {
      status: 200,
      description: 'Published form schema',
      body: schema,
    },
    problems: formProblems,
  }),
  submit: defineRoute({
    operationId: 'submitMemberForm',
    method: 'post',
    path: `${FORM}/submit`,
    params: formParamsSchema,
    headers: submitHeaders,
    access: responding,
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    cacheControl: noStore,
    body: submission,
    success: {
      status: 200,
      description: 'Accepted member submission',
      body: named('FormSubmissionResponse', formSubmissionResponseSchema),
    },
    problems: formProblems,
  }),
  access: defineRoute({
    operationId: 'getFormAccess',
    method: 'get',
    path: `${FORM}/access`,
    params: formParamsSchema,
    access: readingAsManager,
    rateLimit: 'authenticated_read',
    cacheControl: noStore,
    success: {
      status: 200,
      description: 'Current link access, without capability material',
      body: access,
    },
    problems: formProblems,
  }),
  setAccess: defineRoute({
    operationId: 'changeFormAccess',
    method: 'post',
    path: `${FORM}/access`,
    params: formParamsSchema,
    access: managing,
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    cacheControl: noStore,
    body: named('FormAccessRequest', formAccessRequestSchema),
    success: {
      status: 200,
      description: 'Recorded access revision',
      body: access,
    },
    problems: formProblems,
  }),
  publicRead: defineRoute({
    operationId: 'getPublicForm',
    method: 'get',
    path: PUBLIC,
    params: publicFormParamsSchema,
    headers: z.object({ 'x-pertexo-form-key': capabilityHeader }),
    access: { auth: 'public' },
    rateLimit: 'form_read',
    ...publicAnswer,
    success: {
      status: 200,
      description: 'Public field schema only',
      body: schema,
    },
    problems: formProblems,
  }),
  publicSubmit: defineRoute({
    operationId: 'submitPublicForm',
    method: 'post',
    path: `${PUBLIC}/submit`,
    params: publicFormParamsSchema,
    headers: submitHeaders.extend({ 'x-pertexo-form-key': capabilityHeader }),
    access: { auth: 'public' },
    rateLimit: 'form_submission',
    idempotent: true,
    ...publicAnswer,
    body: submission,
    success: {
      status: 200,
      description: 'Acceptance only; no run identity or data',
      body: named(
        'PublicFormSubmissionResponse',
        publicFormSubmissionResponseSchema,
      ),
    },
    problems: formProblems,
  }),
};
