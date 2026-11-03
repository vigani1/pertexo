import type { z } from 'zod';
import { routePaths, routeSchemas } from '../../routes/openapi.js';
import { batchRoutes } from '../../routes/workflows/batch.js';
import { foldersRoutes } from '../../routes/workflows/folders.js';
import { organizationRoutes } from '../../routes/workflows/organization.js';
import {
  workflowCombinedOrganizationProjectionResponseSchema,
  workflowGetQuerySchema,
  workflowOrganizationListQuerySchema,
  workflowOrganizationListResponseSchema,
  workflowOrganizationProjectionResponseSchema,
} from '../../schemas/workflows/authoring.js';
import * as folders from '../../schemas/workflows/organization-folders.js';
import * as organization from '../../schemas/workflows/organization.js';

const definitions = {
  WorkflowTagListQuery: [organization.workflowTagListQuerySchema, 'input'],

  WorkflowOrganizationListQuery: [workflowOrganizationListQuerySchema, 'input'],
  WorkflowOrganizationListResponse: [
    workflowOrganizationListResponseSchema,
    'output',
  ],
  WorkflowOrganizationProjectionResponse: [
    workflowOrganizationProjectionResponseSchema,
    'output',
  ],
  WorkflowCombinedOrganizationProjectionResponse: [
    workflowCombinedOrganizationProjectionResponseSchema,
    'output',
  ],
  WorkflowGetQuery: [workflowGetQuerySchema, 'input'],
  WorkflowFolderListQuery: [folders.workflowFolderListQuerySchema, 'input'],
} as const;

export function workflowOrganizationContractSchemas<Projected>(
  project: (
    name: string,
    schema: z.ZodType,
    io: 'input' | 'output',
  ) => Projected,
) {
  return {
    ...routeSchemas(Object.values(batchRoutes)),
    ...routeSchemas(Object.values(foldersRoutes)),
    ...routeSchemas(Object.values(organizationRoutes)),
    ...(Object.fromEntries(
      Object.entries(definitions).map(([name, [schema, io]]) => [
        name,
        project(name, schema, io),
      ]),
    ) as Record<keyof typeof definitions, Projected>),
  };
}

export const workflowOrganizationContractPaths = {
  ...routePaths(Object.values(batchRoutes)),
  ...routePaths(Object.values(foldersRoutes)),
  ...routePaths(Object.values(organizationRoutes)),
};
