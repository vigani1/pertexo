import type { z } from 'zod';
import { routePaths, routeSchemas } from '../../routes/openapi.js';
import { workflowSettingsRoutes as settings } from '../../routes/workflows/settings.js';
import * as schemas from '../../schemas/workflows/auto-pause.js';

const routes = [
  settings.autoPause,
  settings.updateAutoPause,
  settings.resume,
  settings.workspaceAutoPause,
  settings.updateWorkspaceAutoPause,
];

export function workflowAutoPauseContractSchemas<Projected>(
  project: (
    name: string,
    schema: z.ZodType,
    io: 'input' | 'output',
  ) => Projected,
) {
  return {
    ...routeSchemas(routes),
    // The conflicts a client can tell apart from a generic one.
    WorkflowPauseConflictProblem: project(
      'WorkflowPauseConflictProblem',
      schemas.workflowPauseConflictProblemSchema,
      'output',
    ),
    WorkflowAutoPauseSettingsConflictProblem: project(
      'WorkflowAutoPauseSettingsConflictProblem',
      schemas.workflowAutoPauseSettingsConflictProblemSchema,
      'output',
    ),
    WorkspaceAutoPauseSettingsConflictProblem: project(
      'WorkspaceAutoPauseSettingsConflictProblem',
      schemas.workspaceAutoPauseSettingsConflictProblemSchema,
      'output',
    ),
  };
}
export const workflowAutoPauseContractPaths = routePaths(routes);
