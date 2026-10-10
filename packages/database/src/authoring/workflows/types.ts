import type { DatabaseRuntime } from '../../platform/pool/runtime.js';
import type {
  GraphValidationResult,
  WorkflowGraph,
  WorkflowPortabilityCatalog,
  WorkflowPortableManifest,
} from '@pertexo/workflow-model';
import type { WorkflowDefinitionCatalog } from '@pertexo/workflow-model/server';
import type { WorkflowTemplateOriginRequest } from '@pertexo/templates';

/** Compiles a graph into the executable a published version stores. */
export type WorkflowExecutableCompiler = (graph: WorkflowGraph) => Readonly<{
  checksum: `wf:sha256:${string}`;
  executableJson: unknown;
}>;

export type WorkflowAuthoringGraphValidator = (
  graph: WorkflowGraph,
  options: Readonly<{ signal?: AbortSignal }>,
) => Promise<GraphValidationResult>;

/** The portability catalog, plus the registered check of a template's setup values. */
export type PortableCatalog = WorkflowPortabilityCatalog &
  Readonly<{
    validateTemplateSetup?: (
      manifest: WorkflowPortableManifest,
      origin: WorkflowTemplateOriginRequest,
    ) => boolean;
  }>;

export type WorkflowAuthoringDatabaseOptions = Readonly<{
  portableCatalog?: PortableCatalog;
  definitionCatalog?: WorkflowDefinitionCatalog;
  runtime?: DatabaseRuntime;
  executableCompiler: WorkflowExecutableCompiler;
  validateAuthoringGraph?: WorkflowAuthoringGraphValidator;
}>;
