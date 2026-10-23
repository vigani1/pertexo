import type { z } from 'zod';
import {
  workflowPromotionSettingsSchema,
  workflowPromotionTargetSchema,
  workflowPromotionTargetResultSchema,
} from '../../schemas/workflows/promotions/settings.js';
import {
  workflowPromotionPreviewRequestSchema,
  workflowPromotionPreviewSchema,
} from '../../schemas/workflows/promotions/review.js';
import {
  workflowPromotionApplySchema,
  workflowPromotionResultSchema,
} from '../../schemas/workflows/promotions/commands.js';
import {
  workflowPromotionCandidatesSchema,
  workflowPromotionHistorySchema,
} from '../../schemas/workflows/promotions/history.js';
import {
  csrfHeaderParameter,
  idempotencyHeaderParameter,
  jsonRequest,
  jsonResponse,
  responseReference,
  uuidPathParameter,
} from '../primitives.js';

export function workflowPromotionContractSchemas<Projected>(
  project: (
    name: string,
    schema: z.ZodType,
    io: 'input' | 'output',
  ) => Projected,
) {
  return {
    WorkflowPromotionSettings: project(
      'WorkflowPromotionSettings',
      workflowPromotionSettingsSchema,
      'output',
    ),
    WorkflowPromotionTarget: project(
      'WorkflowPromotionTarget',
      workflowPromotionTargetSchema,
      'input',
    ),
    WorkflowPromotionTargetResult: project(
      'WorkflowPromotionTargetResult',
      workflowPromotionTargetResultSchema,
      'output',
    ),
    WorkflowPromotionCandidates: project(
      'WorkflowPromotionCandidates',
      workflowPromotionCandidatesSchema,
      'output',
    ),
    WorkflowPromotionHistory: project(
      'WorkflowPromotionHistory',
      workflowPromotionHistorySchema,
      'output',
    ),
    WorkflowPromotionPreviewRequest: project(
      'WorkflowPromotionPreviewRequest',
      workflowPromotionPreviewRequestSchema,
      'input',
    ),
    WorkflowPromotionPreview: project(
      'WorkflowPromotionPreview',
      workflowPromotionPreviewSchema,
      'output',
    ),
    WorkflowPromotionApply: project(
      'WorkflowPromotionApply',
      workflowPromotionApplySchema,
      'input',
    ),
    WorkflowPromotionResult: project(
      'WorkflowPromotionResult',
      workflowPromotionResultSchema,
      'output',
    ),
  };
}
function operation({
  operationId,
  response,
  request,
  idempotent = false,
  paged = false,
}: Readonly<{
  operationId: string;
  response: string;
  request?: string | undefined;
  idempotent?: boolean;
  paged?: boolean;
}>) {
  return {
    operationId,
    security: [{ cookieSession: [] }],
    parameters: [
      uuidPathParameter('workspaceId'),
      ...(request === undefined ? [] : [csrfHeaderParameter()]),
      ...(idempotent ? [idempotencyHeaderParameter()] : []),
      ...(paged
        ? [
            {
              name: 'after',
              in: 'query',
              required: false,
              schema: { type: 'string', format: 'uuid' },
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
            },
            {
              name: 'search',
              in: 'query',
              required: false,
              schema: { type: 'string', maxLength: 128 },
            },
          ]
        : []),
    ],
    ...(request === undefined ? {} : { requestBody: jsonRequest(request) }),
    responses: {
      '200': jsonResponse('Promotion result', response),
      '400': responseReference('BadRequest'),
      '401': responseReference('Unauthenticated'),
      '403': responseReference('Forbidden'),
      '404': responseReference('NotFound'),
      '409': responseReference('Conflict'),
      '429': responseReference('RateLimited'),
      '500': responseReference('Unexpected'),
      '503': responseReference('Unavailable'),
    },
  };
}
const candidateList = operation({
  operationId: 'listWorkflowPromotionCandidates',
  response: 'WorkflowPromotionCandidates',
  request: undefined,
  idempotent: false,
  paged: true,
});
export const workflowPromotionContractPaths = {
  '/v1/workspaces/{workspaceId}/promotions/settings': {
    get: operation({
      operationId: 'getWorkflowPromotionSettings',
      response: 'WorkflowPromotionSettings',
    }),
    put: operation({
      operationId: 'setWorkflowPromotionTarget',
      response: 'WorkflowPromotionTargetResult',
      request: 'WorkflowPromotionTarget',
      idempotent: true,
    }),
  },
  '/v1/workspaces/{workspaceId}/promotions/candidates': {
    get: {
      ...candidateList,
      parameters: [
        ...candidateList.parameters,
        {
          name: 'workflowId',
          in: 'query',
          required: false,
          schema: { type: 'string', format: 'uuid' },
        },
        {
          name: 'beforeVersionNumber',
          in: 'query',
          required: false,
          schema: { type: 'integer', minimum: 1, maximum: 2147483647 },
        },
      ],
    },
  },
  '/v1/workspaces/{workspaceId}/promotions/history': {
    get: operation({
      operationId: 'listWorkflowPromotionHistory',
      response: 'WorkflowPromotionHistory',
      request: undefined,
      idempotent: false,
      paged: true,
    }),
  },
  '/v1/workspaces/{workspaceId}/promotions/preview': {
    post: operation({
      operationId: 'previewWorkflowPromotion',
      response: 'WorkflowPromotionPreview',
      request: 'WorkflowPromotionPreviewRequest',
    }),
  },
  '/v1/workspaces/{workspaceId}/promotions/apply': {
    post: operation({
      operationId: 'applyWorkflowPromotion',
      response: 'WorkflowPromotionResult',
      request: 'WorkflowPromotionApply',
      idempotent: true,
    }),
  },
};
