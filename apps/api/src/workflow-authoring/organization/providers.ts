import type { Provider } from '@nestjs/common';
import { WorkflowOrganizationCommandsUseCase } from './commands.js';
import { WorkflowOrganizationReadsUseCase } from './reads.js';
import { WorkflowFoldersUseCase } from './folders/use-case.js';
import { WorkflowOrganizationBatchesUseCase } from './batch/use-case.js';
import type { WorkflowAuthoringDependencies } from '../ports.js';
import { WorkflowOrganizationController } from './controller.js';
import { WorkflowFoldersController } from './folders/controller.js';
import { WorkflowOrganizationBatchesController } from './batch/controller.js';

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
      provide: WorkflowFoldersUseCase,
      useValue: new WorkflowFoldersUseCase(
        organization.folders,
        dependencies.authorization,
      ),
    },
    {
      provide: WorkflowOrganizationBatchesUseCase,
      useValue: new WorkflowOrganizationBatchesUseCase(
        organization.batches,
        dependencies.authorization,
      ),
    },
    {
      provide: WorkflowOrganizationCommandsUseCase,
      useValue: new WorkflowOrganizationCommandsUseCase(
        organization.tags,
        organization.favorites,
        dependencies.authorization,
      ),
    },
    {
      provide: WorkflowOrganizationReadsUseCase,
      useValue: new WorkflowOrganizationReadsUseCase(
        organization.reader,
        organization.tags,
        dependencies.authorization,
        dependencies.persistence,
      ),
    },
  ];
}
