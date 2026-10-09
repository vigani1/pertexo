import type { PoolClient } from 'pg';
import {
  EMPTY_DEFINITION_CATALOG,
  type WorkflowDefinitionCatalog,
} from '@pertexo/workflow-model/server';

import type {
  PortableCatalog,
  WorkflowAuthoringDatabaseOptions,
  WorkflowExecutableCompiler,
  WorkflowAuthoringGraphValidator,
} from './workflow-authoring-types.js';

type WorkflowAuthoringCompatibilitySelection = Readonly<{
  portableCatalog: PortableCatalog | undefined;
  definitionCatalog: WorkflowDefinitionCatalog;
  placementDefinitionCatalog: WorkflowDefinitionCatalog | undefined;
  executableCompiler: WorkflowExecutableCompiler | undefined;
  validateAuthoringGraph: WorkflowAuthoringGraphValidator | undefined;
}>;

type WorkflowAuthoringCompatibility = Readonly<{
  selectLocked(
    client: Pick<PoolClient, 'query'>,
  ): Promise<WorkflowAuthoringCompatibilitySelection>;
}>;

/** The catalogs and compiler this authoring database works against. */
export function normalizeWorkflowAuthoringCompatibility(
  options: WorkflowAuthoringDatabaseOptions,
): WorkflowAuthoringCompatibility {
  const selection = Object.freeze({
    portableCatalog: options.portableCatalog,
    definitionCatalog: options.definitionCatalog ?? EMPTY_DEFINITION_CATALOG,
    // New nodes must come from the configured catalog; without one, any may be placed.
    placementDefinitionCatalog: options.definitionCatalog,
    executableCompiler: options.executableCompiler,
    validateAuthoringGraph: options.validateAuthoringGraph,
  });
  return Object.freeze({ selectLocked: () => Promise.resolve(selection) });
}
