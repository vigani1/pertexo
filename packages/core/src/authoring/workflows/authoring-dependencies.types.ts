import type {
  WorkflowTestPins,
  WorkflowTestCompilation,
} from '@pertexo/workflow-engine';
import type { DatabaseRuntime } from '@pertexo/database/platform';
import type {
  GraphValidationResult,
  WorkflowGraph,
  WorkflowNode,
  WorkflowPortabilityCatalog,
  WorkflowPortableManifest,
} from '@pertexo/workflow-model';
import type {
  WorkflowDefinitionCatalog,
  WorkflowAuthoringValidationOptions,
} from '@pertexo/workflow-model/server';
import type { WorkflowTemplateOriginRequest } from '@pertexo/workflow-model';

/** Compiles a graph into the executable a published version stores. */
export type WorkflowExecutableCompiler = (graph: WorkflowGraph) => Readonly<{
  checksum: `wf:sha256:${string}`;
  executableJson: unknown;
}>;

export type WorkflowAuthoringGraphValidator = (
  graph: WorkflowGraph,
  options: WorkflowAuthoringValidationOptions,
) => Promise<GraphValidationResult>;

/** The portability catalog, plus the registered check of a template's setup values. */
export type PortableCatalog = WorkflowPortabilityCatalog &
  Readonly<{
    validateTemplateSetup?: (
      manifest: WorkflowPortableManifest,
      origin: WorkflowTemplateOriginRequest,
    ) => boolean;
    /** Whether a step's settings would get past the check every run makes of them. */
    acceptsStepConfig?: (node: WorkflowNode) => boolean;
  }>;

export type WorkflowAuthoringStoreOptions = Readonly<{
  portableCatalog?: PortableCatalog;
  definitionCatalog?: WorkflowDefinitionCatalog;
  runtime?: DatabaseRuntime;
  executableCompiler: WorkflowExecutableCompiler;
  workflowTestCompiler?: (
    graph: WorkflowGraph,
    pins: WorkflowTestPins,
  ) => WorkflowTestCompilation;
  validateAuthoringGraph?: WorkflowAuthoringGraphValidator;
}>;
