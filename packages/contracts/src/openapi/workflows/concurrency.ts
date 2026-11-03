import type { z } from 'zod';
import { routePaths, routeSchemas } from '../../routes/openapi.js';
import { workflowSettingsRoutes as settings } from '../../routes/workflows/settings.js';
import * as schemas from '../../schemas/workflows/concurrency.js';

const routes = [settings.concurrency, settings.updateConcurrency];

export function workflowConcurrencyContractSchemas<Projected>(
  project: (
    name: string,
    schema: z.ZodType,
    io: 'input' | 'output',
  ) => Projected,
) {
  return {
    ...routeSchemas(routes),
    // The two conflicts a client can tell apart from a generic one.
    WorkflowConcurrencyRevisionConflictProblem: project(
      'WorkflowConcurrencyRevisionConflictProblem',
      schemas.workflowConcurrencyRevisionConflictProblemSchema,
      'output',
    ),
    WorkflowConcurrencyLimitExceededProblem: project(
      'WorkflowConcurrencyLimitExceededProblem',
      schemas.workflowConcurrencyLimitExceededProblemSchema,
      'output',
    ),
  };
}
export const workflowConcurrencyContractPaths = routePaths(routes);
