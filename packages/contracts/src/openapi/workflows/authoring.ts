import type { z } from 'zod';
import { apiProblemSchema } from '../../errors/api-problem.js';
import { routePaths, routeSchemas } from '../../routes/openapi.js';
import { authoringRoutes } from '../../routes/workflows/authoring.js';
import { lifecycleRoutes } from '../../routes/workflows/lifecycle.js';
import { versionRoutes } from '../../routes/workflows/versions.js';
import {
  strongEtagSchema,
  workflowCompatibilityReportSchema,
  workflowListResponseSchema,
  workflowRevisionConflictProblemSchema,
  workflowSummaryResponseSchema,
  workflowSummarySchema,
  workflowTemplateOriginProjectionResponseSchema,
  workflowVersionResponseSchema,
} from '../../schemas/workflows/authoring.js';
import {
  authenticatedComponents,
  jsonSchema,
  problemResponse,
} from '../primitives.js';
import { projectContractSchema } from '../schema-projection.js';
import {
  workflowAutoPauseContractPaths,
  workflowAutoPauseContractSchemas,
} from './auto-pause.js';
import {
  collaborationContractPaths,
  collaborationContractSchemas,
} from './collaboration/contract.js';
import {
  workflowConcurrencyContractPaths,
  workflowConcurrencyContractSchemas,
} from './concurrency.js';
import {
  workflowErrorContractPaths,
  workflowErrorContractSchemas,
} from './error.js';
import {
  workflowInputCaseContractPaths,
  workflowInputCaseContractSchemas,
} from './input-cases.js';
import {
  workflowOrganizationContractPaths,
  workflowOrganizationContractSchemas,
} from './organization.js';
import {
  workflowPromotionContractPaths,
  workflowPromotionContractSchemas,
} from './promotions.js';
import {
  publicationReviewContractPaths,
  publicationReviewContractSchemas,
} from './publication-review.js';
import { workflowRevisionCommandSchemas } from './revision-commands.js';

function contractSchemas() {
  const project = (name: string, schema: z.ZodType, io: 'input' | 'output') =>
    projectContractSchema(name, schema, io);
  return Object.freeze({
    ...routeSchemas([
      ...Object.values(authoringRoutes),
      ...Object.values(lifecycleRoutes),
      ...Object.values(versionRoutes),
    ]),
    ApiProblem: project('ApiProblem', apiProblemSchema, 'output'),
    ...workflowRevisionCommandSchemas(project),
    ...workflowAutoPauseContractSchemas(project),
    ...workflowConcurrencyContractSchemas(project),
    ...workflowErrorContractSchemas(),
    ...publicationReviewContractSchemas(),
    ...collaborationContractSchemas(),
    ...workflowPromotionContractSchemas(),
    ...workflowInputCaseContractSchemas(project),
    ...workflowOrganizationContractSchemas(project),
    WorkflowRevisionConflictProblem: project(
      'WorkflowRevisionConflictProblem',
      workflowRevisionConflictProblemSchema,
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
    WorkflowCompatibilityReport: project(
      'WorkflowCompatibilityReport',
      workflowCompatibilityReportSchema,
      'output',
    ),
    WorkflowVersionResponse: project(
      'WorkflowVersionResponse',
      workflowVersionResponseSchema,
      'output',
    ),
  });
}
const openApiSchemas = contractSchemas();

const etagResponseHeader = {
  ETag: {
    description: 'Strong opaque validator for this draft representation',
    required: true,
    schema: jsonSchema(strongEtagSchema, 'output'),
  },
} as const;

const problemResponses = Object.freeze({
  BadRequest: problemResponse('Invalid request'),
  Unavailable: problemResponse('Historical template origin unavailable'),
  ValidationUnavailable: {
    ...problemResponse('Workflow validation temporarily unavailable'),
    headers: {
      'Retry-After': {
        description: 'Bounded explicit-retry delay in seconds',
        required: true,
        schema: { type: 'integer', const: 1 },
      },
    },
  },
  PublicationUnavailable: {
    ...problemResponse(
      'Workflow validation, automation token authentication or limiter unavailable',
    ),
    headers: {
      'Retry-After': {
        description:
          'One-second explicit retry delay for validation or limiter unavailability; absent when automation tokens are disabled',
        required: false,
        schema: { type: 'integer', const: 1 },
      },
    },
  },
  PreconditionRequired: problemResponse('Precondition required'),
  PreconditionFailed: {
    description: 'The draft representation is no longer current',
    headers: etagResponseHeader,
    content: {
      'application/problem+json': {
        schema: {
          $ref: '#/components/schemas/WorkflowRevisionConflictProblem',
        },
      },
    },
  },
  Unauthenticated: problemResponse('Authentication required'),
  Forbidden: problemResponse('Forbidden'),
  NotFound: problemResponse('Resource not found'),
  Conflict: problemResponse('Request conflict'),
  UnprocessableEntity: problemResponse('Workflow is not publishable'),
  RateLimited: problemResponse('Rate limited'),
  Unexpected: problemResponse('Unexpected server error'),
});

export const workflowAuthoringOpenApiDocument = Object.freeze({
  openapi: '3.1.0',
  info: {
    title: 'Pertexo Workflow Authoring API',
    version: '1.0.0',
  },
  paths: {
    ...routePaths([
      lifecycleRoutes.duplicate,
      versionRoutes.restoreVersion,
      lifecycleRoutes.archive,
      lifecycleRoutes.restore,
      lifecycleRoutes.rename,
      ...Object.values(authoringRoutes),
      versionRoutes.versions,
    ]),
    ...workflowAutoPauseContractPaths,
    ...workflowConcurrencyContractPaths,
    ...workflowErrorContractPaths,
    ...publicationReviewContractPaths,
    ...collaborationContractPaths,
    ...workflowPromotionContractPaths,
    ...workflowInputCaseContractPaths,
    ...workflowOrganizationContractPaths,
  },
  components: authenticatedComponents(openApiSchemas, problemResponses, {
    automation: true,
  }),
});
