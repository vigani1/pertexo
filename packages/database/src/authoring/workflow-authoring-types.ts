import type { DatabaseRuntime } from '../platform/database-runtime.js';
import type {
  GraphValidationResult,
  WorkflowGraph,
  WorkflowPortabilityCatalog,
  WorkflowPortableManifest,
} from '@pertexo/workflow-model';
import type { WorkflowDefinitionCatalog } from '@pertexo/workflow-model/server';
import type { WorkflowTemplateOriginRequest } from '@pertexo/templates';

export type WorkflowAuthoringTestHooks = Readonly<{
  /** Integration-only ordered-lock and atomic rollback seam. */
  afterImportStep?: (
    step:
      | 'authority'
      | 'claim'
      | 'catalog'
      | 'connections'
      | 'workflow'
      | 'draft'
      | 'audit'
      | 'idempotency',
  ) => Promise<void>;
  afterExportSourceLock?: () => Promise<void>;
  /** Integration-only synchronization/fault seam; omitted in runtime composition. */
  afterDuplicateStep?: (
    step: 'claim' | 'source' | 'workflow' | 'draft' | 'audit' | 'idempotency',
  ) => Promise<void>;
  /** Integration-test synchronization seam; runtime composition must omit it. */
  afterSaveCas?: () => Promise<void>;
  /** Integration-test synchronization/fault seam after both publish locks. */
  afterPublishDraftLock?: () => Promise<void>;
  afterPublishStep?: (
    step:
      | 'version'
      | 'integration_usage'
      | 'trigger_projection'
      | 'pointer'
      | 'outbox'
      | 'audit'
      | 'idempotency',
  ) => Promise<void>;
  /** Integration-test synchronization/fault seam for lifecycle transitions. */
  afterLifecycleStep?: (
    step: 'claim' | 'workflow' | 'outbox' | 'audit' | 'idempotency',
  ) => Promise<void>;
  /** Integration-test synchronization/fault seam for workflow renames. */
  afterRenameStep?: (
    step: 'claim' | 'workflow' | 'audit' | 'idempotency',
  ) => Promise<void>;
  /** Integration-test synchronization/fault seam for version restoration. */
  afterVersionRestoreStep?: (
    step: 'source' | 'draft' | 'audit',
  ) => Promise<void>;
}>;

export type WorkflowExecutableCompiler = (graph: WorkflowGraph) => Readonly<{
  checksum: `wf:v2:sha256:${string}`;
  executableSchemaVersion: 2;
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
  placementDefinitionCatalog?: WorkflowDefinitionCatalog;
  runtime?: DatabaseRuntime;
  executableCompiler?: WorkflowExecutableCompiler;
  validateAuthoringGraph?: WorkflowAuthoringGraphValidator;
  testHooks?: WorkflowAuthoringTestHooks;
}>;
