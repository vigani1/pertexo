import type { Provider } from '@nestjs/common';
import { WorkflowOrganizationCommandsService } from './organization-commands.service.js';
import { WorkflowOrganizationReadsService } from './organization-reads.service.js';
import { WorkflowFoldersService } from './folders/workflow-folders.service.js';
import { WorkflowOrganizationBatchesService } from './batch/workflow-organization-batches.service.js';
import type { WorkflowAuthoringDependencies } from '../ports.js';
import { WorkflowOrganizationController } from './workflow-organization.controller.js';
import { WorkflowFoldersController } from './folders/workflow-folders.controller.js';
import { WorkflowOrganizationBatchesController } from './batch/workflow-organization-batches.controller.js';

export const workflowOrganizationControllers = [
  WorkflowOrganizationController,
  WorkflowFoldersController,
  WorkflowOrganizationBatchesController,
] as const;

export function workflowOrganizationProviders(
  dependencies: WorkflowAuthoringDependencies,
): Provider[] {
  const { organization } = dependencies;
  return [
    {
      provide: WorkflowFoldersService,
      useValue: new WorkflowFoldersService(
        organization.folders,
        dependencies.authorization,
      ),
    },
    {
      provide: WorkflowOrganizationBatchesService,
      useValue: new WorkflowOrganizationBatchesService(
        organization.batches,
        dependencies.authorization,
      ),
    },
    {
      provide: WorkflowOrganizationCommandsService,
      useValue: new WorkflowOrganizationCommandsService(
        organization.tags,
        organization.favorites,
        dependencies.authorization,
      ),
    },
    {
      provide: WorkflowOrganizationReadsService,
      useValue: new WorkflowOrganizationReadsService(
        organization.reader,
        organization.tags,
        dependencies.authorization,
        dependencies.persistence,
      ),
    },
  ];
}
