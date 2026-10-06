import { apiProblemSchema } from './errors/api-problem.js';
import { workflowOrganizationContractSchemas } from './workflow-organization-contract.js';
import { workflowInputCaseContractSchemas } from './workflow-input-cases-contract.js';
import { workflowConcurrencyContractSchemas } from './workflow-concurrency-contract.js';
import { workflowAutoPauseContractSchemas } from './workflow-auto-pause-contract.js';
import {
  workflowCompatibilityReportSchema,
  workflowCreateRequestSchema,
  workflowCreateResponseSchema,
  workflowDuplicateRequestSchema,
  workflowDuplicateResponseSchema,
  workflowDraftResponseSchema,
  workflowDraftSaveRequestSchema,
  workflowListResponseSchema,
  workflowVersionRestoreRequestSchema,
  workflowPublishResponseSchema,
  workflowRevisionConflictProblemSchema,
  workflowSummarySchema,
  workflowSummaryResponseSchema,
  workflowTemplateOriginProjectionResponseSchema,
  workflowValidateResponseSchema,
  workflowVersionResponseSchema,
  workflowVersionsResponseSchema,
  workflowCallableTargetsQuerySchema,
  workflowCallableTargetsResponseSchema,
  workflowCallableTargetsUnavailableProblemSchema,
} from './http/workflow-authoring.js';
import { projectContractSchema } from './schema-projection.js';
import { workflowRevisionCommandSchemas } from './workflow-revision-commands-contract.js';
import type { z } from 'zod';

export function workflowAuthoringContractSchemas(target: 'client' | 'openapi') {
  const project = (name: string, schema: z.ZodType, io: 'input' | 'output') =>
    projectContractSchema(name, schema, io, target);
  return Object.freeze({
    ApiProblem: project('ApiProblem', apiProblemSchema, 'output'),
    WorkflowDuplicateRequest: project(
      'WorkflowDuplicateRequest',
      workflowDuplicateRequestSchema,
      'input',
    ),
    WorkflowDuplicateResponse: project(
      'WorkflowDuplicateResponse',
      workflowDuplicateResponseSchema,
      'output',
    ),
    WorkflowVersionRestoreRequest: project(
      'WorkflowVersionRestoreRequest',
      workflowVersionRestoreRequestSchema,
      'input',
    ),
    ...workflowRevisionCommandSchemas(project),
    ...workflowAutoPauseContractSchemas(project),
    ...workflowConcurrencyContractSchemas(project),
    ...workflowInputCaseContractSchemas(project),
    ...workflowOrganizationContractSchemas(project),
    WorkflowRevisionConflictProblem: project(
      'WorkflowRevisionConflictProblem',
      workflowRevisionConflictProblemSchema,
      'output',
    ),
    WorkflowCreateRequest: project(
      'WorkflowCreateRequest',
      workflowCreateRequestSchema,
      'input',
    ),
    WorkflowCreateResponse: project(
      'WorkflowCreateResponse',
      workflowCreateResponseSchema,
      'output',
    ),
    WorkflowSummary: project(
      'WorkflowSummary',
      workflowSummarySchema,
      'output',
    ),
    WorkflowSummaryResponse: project(
      'WorkflowSummaryResponse',
      workflowSummaryResponseSchema,
      'output',
    ),
    WorkflowTemplateOriginProjectionResponse: project(
      'WorkflowTemplateOriginProjectionResponse',
      workflowTemplateOriginProjectionResponseSchema,
      'output',
    ),
    WorkflowListResponse: project(
      'WorkflowListResponse',
      workflowListResponseSchema,
      'output',
    ),
    WorkflowDraftSaveRequest: project(
      'WorkflowDraftSaveRequest',
      workflowDraftSaveRequestSchema,
      'input',
    ),
    WorkflowDraftResponse: project(
      'WorkflowDraftResponse',
      workflowDraftResponseSchema,
      'output',
    ),
    WorkflowCompatibilityReport: project(
      'WorkflowCompatibilityReport',
      workflowCompatibilityReportSchema,
      'output',
    ),
    WorkflowValidationResponse: project(
      'WorkflowValidationResponse',
      workflowValidateResponseSchema,
      'output',
    ),
    WorkflowPublishResponse: project(
      'WorkflowPublishResponse',
      workflowPublishResponseSchema,
      'output',
    ),
    WorkflowVersionResponse: project(
      'WorkflowVersionResponse',
      workflowVersionResponseSchema,
      'output',
    ),
    WorkflowVersionsResponse: project(
      'WorkflowVersionsResponse',
      workflowVersionsResponseSchema,
      'output',
    ),
    WorkflowCallableTargetsQuery: project(
      'WorkflowCallableTargetsQuery',
      workflowCallableTargetsQuerySchema,
      'input',
    ),
    WorkflowCallableTargetsResponse: project(
      'WorkflowCallableTargetsResponse',
      workflowCallableTargetsResponseSchema,
      'output',
    ),
    WorkflowCallableTargetsUnavailableProblem: project(
      'WorkflowCallableTargetsUnavailableProblem',
      workflowCallableTargetsUnavailableProblemSchema,
      'output',
    ),
  });
}
