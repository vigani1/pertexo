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
export interface SuiteRow {
  id: string;
  workspace_id: string;
  workflow_id: string;
  started_by: string;
  snapshot_id: string;
  signature: string;
  variable_set_revision: number | null;
  uses_connections: boolean;
  initial_checkpoint: unknown;
  case_duration_ms: number;
  status: WorkflowTestSuiteSummary['status'];
  stop_reason: string | null;
  cancel_requested: boolean;
  created_at: Date;
  completed_at: Date | null;
  deadline_at: Date;
  expires_at: Date;
}
export interface SuiteCaseRow {
  workspace_id: string;
  suite_id: string;
  ordinal: number;
  case_id: string;
  case_revision: number;
  name: string;
  input: string;
  expectations: string;
  run_id: string | null;
  status: WorkflowTestSuiteDetail['cases'][number]['status'];
  report: string | null;
}
