import type {
  workflowTestSuites,
  workflowTestSuiteCases,
} from '@pertexo/database/schema';
import type {
  WorkflowTestSuiteCurrent,
  WorkflowTestSuitePreparation,
  WorkflowTestSuiteStartRequest,
  WorkflowTestSuiteSummary,
  WorkflowTestSuiteDetail,
  WorkflowTestSuiteReport,
} from '@pertexo/contracts';
import type { SampleScope } from '../../authoring/step-samples/contract.js';
export interface WorkflowTestSuiteStore {
  prepare(input: SampleScope): Promise<WorkflowTestSuitePreparation>;
  start(
    input: SampleScope & {
      idempotencyKey: string;
      request: WorkflowTestSuiteStartRequest;
    },
  ): Promise<{ suiteId: string }>;
  list(input: SampleScope): Promise<{
    current: WorkflowTestSuiteCurrent;
    items: readonly WorkflowTestSuiteSummary[];
  }>;
  get(
    input: SampleScope & { suiteId: string },
  ): Promise<WorkflowTestSuiteDetail>;
  report(input: SampleScope & { suiteId: string; ordinal: number }): Promise<{
    report: WorkflowTestSuiteReport | null;
    stepLabels: Readonly<Record<string, string>>;
  }>;
  cancel(input: SampleScope & { suiteId: string }): Promise<void>;
}
export interface WorkflowTestSuiteScanner {
  scan(limit: number, signal?: AbortSignal): Promise<number>;
  close(): Promise<void>;
}
export type SuiteRow = typeof workflowTestSuites.$inferSelect;
export type SuiteCaseRow = typeof workflowTestSuiteCases.$inferSelect;
