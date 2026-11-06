import {
  acquireDatabasePool,
  type DatabaseConfig,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import type { WorkflowAuthoringStore } from '@pertexo/core/authoring';
import {
  createPreviewRunStore,
  createWorkflowTestStore,
  createWorkflowTestSuiteStore,
  type WorkflowTestCompiler,
} from '@pertexo/core/previews';
import type { NodeTestingPersistence } from '../../../node-testing/ports.js';

/** The API owns the preview resources alongside its authoring resources. */
export function createNodeTestingRuntime(
  config: DatabaseConfig,
  authoring: Pick<WorkflowAuthoringStore, 'getDraft' | 'stepSamples'>,
  workflowTestCompiler: WorkflowTestCompiler,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime);
  const persistence: NodeTestingPersistence = Object.freeze({
    getDraft: authoring.getDraft,
    stepSamples: authoring.stepSamples,
    ...createPreviewRunStore(lease.pool),
    workflowTests: createWorkflowTestStore(lease.pool, {
      workflowTestCompiler,
    }),
    workflowTestSuites: createWorkflowTestSuiteStore(lease.pool, {
      workflowTestCompiler,
    }),
  });
  return Object.freeze({ persistence, close: () => lease.close() });
}

export type NodeTestingRuntime = ReturnType<typeof createNodeTestingRuntime>;
