import type { WorkflowActor } from '../../shared/workflow-actor.js';
import type {
  workflowTestSuites,
  workflowTestSuiteCases,
} from '@pertexo/database/schema';
import type { WorkflowTestSuiteStartRequest } from '@pertexo/contracts';

export type WorkflowTestSuiteStartInput = WorkflowActor &
  Readonly<{
    idempotencyKey: string;
    request: WorkflowTestSuiteStartRequest;
  }>;
export type WorkflowTestSuiteInput = WorkflowActor &
  Readonly<{ suiteId: string }>;
export type WorkflowTestSuiteCaseInput = WorkflowTestSuiteInput &
  Readonly<{ ordinal: number }>;
export interface WorkflowTestSuiteScanner {
  scan(limit: number, signal?: AbortSignal): Promise<number>;
  close(): Promise<void>;
}
export type SuiteRow = typeof workflowTestSuites.$inferSelect;
export type SuiteCaseRow = typeof workflowTestSuiteCases.$inferSelect;
