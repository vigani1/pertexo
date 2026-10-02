import type { Provider } from '@nestjs/common';
import { WorkflowOrganizationCommandsUseCase } from './organization-command-use-case.js';
import { WorkflowOrganizationReadsUseCase } from './organization-read-use-case.js';
import type { WorkflowAuthoringDependencies } from './ports.js';

/** Unsupported cryptographic/read capabilities stay unavailable, not empty. */
export function workflowOrganizationProviders(
  dependencies: WorkflowAuthoringDependencies,
): Provider[] {
  const organization = dependencies.organization;
  if (organization === undefined) return [];
  return [
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
        organization.cursors,
        dependencies.authorization,
        dependencies.persistence,
      ),
    },
  ];
}
