import {
  EMPTY_DEFINITION_CATALOG,
  type WorkflowDefinitionCatalog,
} from '@pertexo/workflow-model/server';

import type {
  PortableCatalog,
  WorkflowAuthoringStoreOptions,
  WorkflowExecutableCompiler,
  WorkflowAuthoringGraphValidator,
} from './types.js';

/** The catalogs and compiler an authoring database works against. */
export type AuthoringCatalogs = Readonly<{
  portableCatalog: PortableCatalog | undefined;
  definitionCatalog: WorkflowDefinitionCatalog;
  /** New nodes must come from it; without one, any node may be placed. */
  placementDefinitionCatalog: WorkflowDefinitionCatalog | undefined;
  executableCompiler: WorkflowExecutableCompiler;
  workflowTestCompiler: WorkflowAuthoringStoreOptions['workflowTestCompiler'];
  validateAuthoringGraph: WorkflowAuthoringGraphValidator | undefined;
}>;

export function authoringCatalogs(
  options: WorkflowAuthoringStoreOptions,
): AuthoringCatalogs {
  return Object.freeze({
    portableCatalog: options.portableCatalog,
    definitionCatalog: options.definitionCatalog ?? EMPTY_DEFINITION_CATALOG,
    placementDefinitionCatalog: options.definitionCatalog,
    executableCompiler: options.executableCompiler,
    workflowTestCompiler: options.workflowTestCompiler,
    validateAuthoringGraph: options.validateAuthoringGraph,
  });
}
