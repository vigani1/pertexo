import type { z } from 'zod';
import * as schemas from '../../schemas/workflows/input-cases.js';
import { routePaths, routeSchemas } from '../../routes/openapi.js';
import { inputCaseRoutes } from '../../routes/workflows/input-cases.js';

const routes = Object.values(inputCaseRoutes);

export function workflowInputCaseContractSchemas<Projected>(
  project: (
    name: string,
    schema: z.ZodType,
    io: 'input' | 'output',
  ) => Projected,
) {
  return {
    ...routeSchemas(routes),
    // The shape inside a page, named for clients.
    WorkflowInputCaseMetadata: project(
      'WorkflowInputCaseMetadata',
      schemas.workflowInputCaseMetadataSchema,
      'output',
    ),
  };
}
export const workflowInputCaseContractPaths = routePaths(routes);
