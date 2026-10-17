import type { z } from 'zod';
import * as schemas from '../../schemas/workflows/publication-review.js';
import {
  csrfHeaderParameter,
  idempotencyHeaderParameter,
  jsonRequest,
  jsonResponse,
  responseReference,
  uuidPathParameter,
} from '../primitives.js';

export function publicationReviewContractSchemas<Projected>(
  project: (
    name: string,
    schema: z.ZodType,
    io: 'input' | 'output',
  ) => Projected,
) {
  return {
    PublicationReview: project(
      'PublicationReview',
      schemas.publicationReviewSchema,
      'output',
    ),
    PublicationReviewOverview: project(
      'PublicationReviewOverview',
      schemas.publicationReviewOverviewSchema,
      'output',
    ),
    PublicationReviewDetail: project(
      'PublicationReviewDetail',
      schemas.publicationReviewDetailSchema,
      'output',
    ),
    PublicationReviewRequest: project(
      'PublicationReviewRequest',
      schemas.publicationReviewRequestSchema,
      'input',
    ),
    PublicationReviewDecision: project(
      'PublicationReviewDecision',
      schemas.publicationReviewDecisionSchema,
      'input',
    ),
  };
}
function operation(
  operationId: string,
  response: string,
  id: 'workflowId' | 'requestId',
  request?: string,
) {
  return {
    operationId,
    security: [{ cookieSession: [] }],
    parameters: [
      uuidPathParameter('workspaceId'),
      uuidPathParameter(id),
      ...(request === undefined
        ? []
        : [csrfHeaderParameter(), idempotencyHeaderParameter()]),
      ...(request === 'PublicationReviewRequest'
        ? [
            {
              name: 'If-Match',
              in: 'header',
              required: true,
              schema: { type: 'string' },
              description: 'The exact saved draft representation tag.',
            },
          ]
        : []),
    ],
    ...(request === undefined ? {} : { requestBody: jsonRequest(request) }),
    responses: {
      [request === 'PublicationReviewRequest' ? '201' : '200']: jsonResponse(
        'Publication review',
        response,
      ),
      '400': responseReference('BadRequest'),
      '401': responseReference('Unauthenticated'),
      '403': responseReference('Forbidden'),
      '404': responseReference('NotFound'),
      '409': responseReference('Conflict'),
      '412': responseReference('PreconditionFailed'),
      '429': responseReference('RateLimited'),
      '500': responseReference('Unexpected'),
    },
  };
}
export const publicationReviewContractPaths = {
  '/v1/workspaces/{workspaceId}/workflows/{workflowId}/publication-review': {
    get: operation(
      'getPublicationReviewOverview',
      'PublicationReviewOverview',
      'workflowId',
    ),
    post: operation(
      'requestPublicationReview',
      'PublicationReview',
      'workflowId',
      'PublicationReviewRequest',
    ),
  },
  '/v1/workspaces/{workspaceId}/publication-requests/{requestId}': {
    get: operation(
      'getPublicationReview',
      'PublicationReviewDetail',
      'requestId',
    ),
  },
  '/v1/workspaces/{workspaceId}/publication-requests/{requestId}/decision': {
    post: operation(
      'decidePublicationReview',
      'PublicationReview',
      'requestId',
      'PublicationReviewDecision',
    ),
  },
};
