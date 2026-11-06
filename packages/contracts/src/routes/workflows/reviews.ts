import { z } from 'zod';

import { responseReference } from '../../openapi/primitives.js';
import { workflowIdParamSchema } from '../../schemas/workflows/authoring.js';
import * as schemas from '../../schemas/workflows/publication-review.js';
import { defineRoute } from '../define.js';
import {
  problems,
  projected,
  publishing,
  reading,
  session,
  WORKFLOW,
} from './access.js';

const REQUEST = '/v1/workspaces/{workspaceId}/publication-requests/{requestId}';
const noStore = 'private, no-store';
const readProblems = {
  ...problems('400', '401', '403', '404', '409'),
  '412': responseReference('PreconditionFailed'),
  '429': responseReference('RateLimited'),
  '500': responseReference('Unexpected'),
};
const commandProblems = {
  ...readProblems,
  '422': responseReference('PublicationUnprocessable'),
};
const review = projected('PublicationReview', schemas.publicationReviewSchema);

/** Publication review: a publish request that an approver decides. */
export const publicationReviewRoutes = {
  overview: defineRoute({
    operationId: 'getPublicationReviewOverview',
    method: 'get',
    path: `${WORKFLOW}/publication-review`,
    params: workflowIdParamSchema,
    access: reading,
    rateLimit: 'authenticated_read',
    cacheControl: noStore,
    success: {
      status: 200,
      description: 'Publication review',
      body: projected(
        'PublicationReviewOverview',
        schemas.publicationReviewOverviewSchema,
      ),
    },
    problems: readProblems,
  }),
  request: defineRoute({
    operationId: 'requestPublicationReview',
    method: 'post',
    path: `${WORKFLOW}/publication-review`,
    params: workflowIdParamSchema,
    access: publishing,
    rateLimit: 'workflow_compile',
    idempotent: true,
    precondition: {
      description: 'The exact saved draft representation tag.',
      schema: z.string(),
    },
    cacheControl: noStore,
    body: projected(
      'PublicationReviewRequest',
      schemas.publicationReviewRequestSchema,
    ),
    success: { status: 201, description: 'Publication review', body: review },
    problems: commandProblems,
  }),
  read: defineRoute({
    operationId: 'getPublicationReview',
    method: 'get',
    path: REQUEST,
    params: schemas.publicationReviewParamsSchema,
    access: reading,
    rateLimit: 'authenticated_read',
    cacheControl: noStore,
    success: {
      status: 200,
      description: 'Publication review',
      body: projected(
        'PublicationReviewDetail',
        schemas.publicationReviewDetailSchema,
      ),
    },
    problems: readProblems,
  }),
  decide: defineRoute({
    operationId: 'decidePublicationReview',
    method: 'post',
    path: `${REQUEST}/decision`,
    params: schemas.publicationReviewParamsSchema,
    access: session('governance:manage'),
    rateLimit: 'workflow_compile',
    idempotent: true,
    cacheControl: noStore,
    body: projected(
      'PublicationReviewDecision',
      schemas.publicationReviewDecisionSchema,
    ),
    success: { status: 200, description: 'Publication review', body: review },
    problems: commandProblems,
  }),
};
