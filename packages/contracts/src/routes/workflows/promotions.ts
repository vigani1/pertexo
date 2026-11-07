import { BROWSABLE_WORKSPACE_STATUSES } from '@pertexo/policy';

import { responseReference } from '../../openapi/primitives.js';
import * as commands from '../../schemas/workflows/promotions/promotion-commands.js';
import * as history from '../../schemas/workflows/promotions/history.js';
import * as review from '../../schemas/workflows/promotions/review.js';
import * as settings from '../../schemas/workflows/promotions/settings.js';
import { defineRoute, type NamedSchema } from '../define.js';
import {
  problems,
  projected,
  session,
  updating,
  workspaceParams,
} from './access.js';

const ROOT = '/v1/workspaces/{workspaceId}/promotions';
/** Editors may look at promotion without the workspace being active. */
const editorReading = session('workflow:update', BROWSABLE_WORKSPACE_STATUSES);
const promotionProblems = {
  ...problems('400', '401', '403', '404', '409'),
  '429': responseReference('RateLimited'),
  '500': responseReference('Unexpected'),
  '503': responseReference('PromotionUnavailable'),
};
const noStore = 'private, no-store';
const result = (body: NamedSchema) => ({
  status: 200,
  description: 'Promotion result',
  body,
});

/** Promoting published workflows to the workspace's target. */
export const promotionRoutes = {
  settings: defineRoute({
    operationId: 'getWorkflowPromotionSettings',
    method: 'get',
    path: `${ROOT}/settings`,
    params: workspaceParams,
    access: editorReading,
    rateLimit: 'authenticated_read',
    cacheControl: noStore,
    success: result(
      projected(
        'WorkflowPromotionSettings',
        settings.workflowPromotionSettingsSchema,
      ),
    ),
    problems: promotionProblems,
  }),
  setTarget: defineRoute({
    operationId: 'setWorkflowPromotionTarget',
    method: 'put',
    path: `${ROOT}/settings`,
    params: workspaceParams,
    access: session('workspace:manage'),
    rateLimit: 'ordinary_mutation',
    idempotent: true,
    cacheControl: noStore,
    body: projected(
      'WorkflowPromotionTarget',
      settings.workflowPromotionTargetSchema,
    ),
    success: result(
      projected(
        'WorkflowPromotionTargetResult',
        settings.workflowPromotionTargetResultSchema,
      ),
    ),
    problems: promotionProblems,
  }),
  candidates: defineRoute({
    operationId: 'listWorkflowPromotionCandidates',
    method: 'get',
    path: `${ROOT}/candidates`,
    params: workspaceParams,
    query: history.workflowPromotionCandidatesQuerySchema,
    access: editorReading,
    rateLimit: 'authenticated_read',
    cacheControl: noStore,
    success: result(
      projected(
        'WorkflowPromotionCandidates',
        history.workflowPromotionCandidatesSchema,
      ),
    ),
    problems: promotionProblems,
  }),
  history: defineRoute({
    operationId: 'listWorkflowPromotionHistory',
    method: 'get',
    path: `${ROOT}/history`,
    params: workspaceParams,
    query: history.workflowPromotionPageQuerySchema,
    access: editorReading,
    rateLimit: 'authenticated_read',
    cacheControl: noStore,
    success: result(
      projected(
        'WorkflowPromotionHistory',
        history.workflowPromotionHistorySchema,
      ),
    ),
    problems: promotionProblems,
  }),
  preview: defineRoute({
    operationId: 'previewWorkflowPromotion',
    method: 'post',
    path: `${ROOT}/preview`,
    params: workspaceParams,
    access: updating,
    rateLimit: 'workflow_compile',
    cacheControl: noStore,
    body: projected(
      'WorkflowPromotionPreviewRequest',
      review.workflowPromotionPreviewRequestSchema,
    ),
    success: result(
      projected(
        'WorkflowPromotionPreview',
        review.workflowPromotionPreviewSchema,
      ),
    ),
    problems: promotionProblems,
  }),
  apply: defineRoute({
    operationId: 'applyWorkflowPromotion',
    method: 'post',
    path: `${ROOT}/apply`,
    params: workspaceParams,
    access: updating,
    rateLimit: 'workflow_compile',
    idempotent: true,
    cacheControl: noStore,
    body: projected(
      'WorkflowPromotionApply',
      commands.workflowPromotionApplySchema,
    ),
    success: result(
      projected(
        'WorkflowPromotionResult',
        commands.workflowPromotionResultSchema,
      ),
    ),
    problems: promotionProblems,
  }),
};
