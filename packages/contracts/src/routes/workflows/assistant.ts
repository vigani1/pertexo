import { responseSchema } from '../../schemas/shared/response-schema.js';
import { z } from 'zod';
import * as explanation from '../../schemas/workflows/assistant/explanation.js';
import * as proposal from '../../schemas/workflows/assistant/proposal.js';
import * as settings from '../../schemas/workflows/assistant/settings.js';
import { defineRoute } from '../define.js';
import { responseReference } from '../openapi-primitives.js';
import { projected, readProblems, session, workspaceParams } from './access.js';

const settingsPath = '/v1/workspaces/{workspaceId}/assistant';
const explainPath = '/v1/workspaces/{workspaceId}/runs/{runId}/explanation';
const proposalPath =
  '/v1/workspaces/{workspaceId}/workflows/{workflowId}/draft/proposal';
const proposalParams = workspaceParams.extend({ workflowId: z.uuid() });
const params = workspaceParams.extend({ runId: z.uuid() });
const common = {
  cacheControl: 'private, no-store',
  problems: readProblems,
} as const;

export const assistantRoutes = {
  proposalDisclosure: defineRoute({
    ...common,
    operationId: 'getDraftProposalDisclosure',
    method: 'get',
    path: proposalPath,
    params: proposalParams,
    access: session('workflow:read'),
    rateLimit: 'authenticated_read',
    description: 'Identify the endpoint before sending filtered draft context.',
    success: {
      status: 200,
      description: 'Transfer disclosure',
      body: projected(
        'DraftProposalDisclosure',
        responseSchema(proposal.draftProposalDisclosureSchema),
      ),
    },
  }),
  proposeDraft: defineRoute({
    ...common,
    operationId: 'proposeWorkflowDraft',
    method: 'post',
    path: proposalPath,
    params: proposalParams,
    access: session('workflow:read'),
    rateLimit: 'assistant_request',
    problems: {
      ...readProblems,
      '412': responseReference('PreconditionFailed'),
      '429': responseReference('RateLimited'),
    },
    description:
      'Inspect a suggested draft against the current draft revision.',
    body: projected(
      'DraftProposalRequest',
      proposal.draftProposalRequestSchema,
    ),
    success: {
      status: 200,
      description: 'Draft proposal outcome',
      body: projected(
        'DraftProposalResult',
        responseSchema(proposal.draftProposalResultSchema),
      ),
    },
  }),
  settings: defineRoute({
    ...common,
    operationId: 'getAssistantSettings',
    method: 'get',
    path: settingsPath,
    params: workspaceParams,
    access: session('connection:manage'),
    rateLimit: 'authenticated_read',
    description: 'Read the workspace assistant selection.',
    success: {
      status: 200,
      description: 'Workspace assistant settings',
      body: projected(
        'AssistantSettings',
        responseSchema(settings.assistantSettingsSchema),
      ),
    },
  }),
  updateSettings: defineRoute({
    ...common,
    operationId: 'updateAssistantSettings',
    method: 'put',
    path: settingsPath,
    params: workspaceParams,
    access: session('connection:manage'),
    rateLimit: 'ordinary_mutation',
    description:
      'Select an active AI connection and model for the workspace assistant.',
    body: projected('AssistantSettings', settings.assistantSettingsSchema),
    success: {
      status: 200,
      description: 'Assistant settings update outcome',
      body: projected(
        'AssistantSettingsResult',
        responseSchema(settings.assistantSettingsResultSchema),
      ),
    },
  }),
  disclosure: defineRoute({
    ...common,
    operationId: 'getExplanationDisclosure',
    method: 'get',
    path: explainPath,
    params,
    access: session('run:read'),
    rateLimit: 'authenticated_read',
    description: 'Identify the endpoint before sending failed run context.',
    success: {
      status: 200,
      description: 'Transfer disclosure',
      body: projected(
        'ExplanationDisclosure',
        responseSchema(explanation.explanationDisclosureSchema),
      ),
    },
  }),
  explain: defineRoute({
    ...common,
    operationId: 'explainFailedRun',
    method: 'post',
    path: explainPath,
    params,
    access: session('run:read'),
    // With the 12 s deadline, this limits overlapping requests per workspace
    // without holding database connections while waiting for inference.
    rateLimit: 'assistant_request',
    problems: { ...readProblems, '429': responseReference('RateLimited') },
    description:
      'Request an explanation of a failed run from the confirmed endpoint.',
    body: projected(
      'ExplainFailedRunRequest',
      explanation.explainFailedRunRequestSchema,
    ),
    success: {
      status: 200,
      description: 'Explanation request outcome',
      body: projected(
        'ExplainFailedRunResult',
        responseSchema(explanation.explainFailedRunResultSchema),
      ),
    },
  }),
} as const;
