import type { DatabaseRuntime } from '../platform/database-runtime.js';
import type { CompatibilityReleaseExpectation } from '../compatibility/compatibility-release.js';
import type {
  WorkflowDefinitionCatalogV1,
  WorkflowGraph,
} from '@pertexo/workflow-model/graph';

export type WorkflowAuthoringTestHooks = Readonly<{
  /** Integration-test synchronization seam after the durable release lock. */
  afterCompatibilityReleaseLock?: () => Promise<void>;
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
  /** Integration-test synchronization/fault seam for version restoration. */
  afterVersionRestoreStep?: (
    step: 'source' | 'draft' | 'audit',
  ) => Promise<void>;
}>;

export type WorkflowExecutableCompiler = (graph: WorkflowGraph) => Readonly<{
  checksum: `wf:v2:sha256:${string}`;
  executableSchemaVersion: 2;
  executableJson: unknown;
  compatibilityReleaseEpoch: number;
  compatibilityReleaseFingerprint: string;
}>;

type WorkflowAuthoringCompatibilityVariant = Readonly<{
  compatibilityRelease: CompatibilityReleaseExpectation;
  definitionCatalog: WorkflowDefinitionCatalogV1;
  placementDefinitionCatalog: WorkflowDefinitionCatalogV1;
  executableCompiler: WorkflowExecutableCompiler;
}>;

export type WorkflowAuthoringDatabaseOptions = Readonly<{
  compatibilityRelease?: CompatibilityReleaseExpectation;
  compatibilityReleaseVariants?: readonly WorkflowAuthoringCompatibilityVariant[];
  compatibilityReadinessReleases?: readonly CompatibilityReleaseExpectation[];
  definitionCatalog?: WorkflowDefinitionCatalogV1;
  placementDefinitionCatalog?: WorkflowDefinitionCatalogV1;
  runtime?: DatabaseRuntime;
  executableCompiler?: WorkflowExecutableCompiler;
  testHooks?: WorkflowAuthoringTestHooks;
}>;
