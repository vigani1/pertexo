import type { FormStore } from '@pertexo/core/triggers';

import type { PendingTaskStore } from '@pertexo/core/runs';

import type { WorkspaceDatabase } from '@pertexo/database/platform';
import type { WorkflowAuthoringStore } from '@pertexo/core/authoring';
import type {
  JsonataEvaluator,
  WorkflowAuthoringValidator,
} from '@pertexo/workflow-model/server';

import type { ApiWorkflowMetadataRuntime } from '../metadata-runtime.js';
import type { RunEventNotificationPublisher } from '../../../workflow-runs/events/index.js';

import type { createPostgresWorkflowRunPersistence } from '../../../workflow-runs/index.js';

export async function closeWorkflowResources(
  authoring: WorkflowAuthoringStore,
  runs: ReturnType<typeof createPostgresWorkflowRunPersistence> | undefined,
  {
    events,
    notifications,
    expressionEvaluator,
    authoringValidator,
    metadata,
    pendingTasks,
    forms,
  }: Readonly<{
    events: WorkspaceDatabase | undefined;
    notifications: RunEventNotificationPublisher | undefined;
    expressionEvaluator: JsonataEvaluator;
    authoringValidator:
      Pick<WorkflowAuthoringValidator, 'shutdown'> | undefined;
    metadata: ApiWorkflowMetadataRuntime | undefined;
    pendingTasks: PendingTaskStore | undefined;
    forms: FormStore | undefined;
  }>,
): Promise<void> {
  const failures = await collectWorkflowCloseFailures(authoring, runs, {
    events: events,
    notifications: notifications,
    expressionEvaluator: expressionEvaluator,
    authoringValidator: authoringValidator,
    metadata: metadata,
    pendingTasks: pendingTasks,
    forms: forms,
  });
  if (failures.length > 0)
    throw new AggregateError(failures, 'Workflow resource shutdown failed');
}

export async function collectWorkflowCloseFailures(
  authoring: WorkflowAuthoringStore | undefined,
  runs: ReturnType<typeof createPostgresWorkflowRunPersistence> | undefined,
  {
    events,
    notifications,
    expressionEvaluator,
    authoringValidator,
    metadata,
    pendingTasks,
    forms,
  }: Readonly<{
    events: WorkspaceDatabase | undefined;
    notifications: RunEventNotificationPublisher | undefined;
    expressionEvaluator: JsonataEvaluator | undefined;
    authoringValidator:
      Pick<WorkflowAuthoringValidator, 'shutdown'> | undefined;
    metadata: ApiWorkflowMetadataRuntime | undefined;
    pendingTasks: PendingTaskStore | undefined;
    forms: FormStore | undefined;
  }>,
): Promise<unknown[]> {
  const failures: unknown[] = [];
  try {
    await authoringValidator?.shutdown();
  } catch (error) {
    failures.push(error);
  }
  const results = await Promise.allSettled([
    Promise.resolve().then(() => authoring?.close()),
    Promise.resolve().then(() => metadata?.close()),
    Promise.resolve().then(() => pendingTasks?.close()),
    Promise.resolve().then(() => forms?.close()),
    Promise.resolve().then(() => runs?.close()),
    Promise.resolve().then(() => events?.close()),
    Promise.resolve().then(() => notifications?.close()),
    Promise.resolve().then(() => expressionEvaluator?.shutdown()),
  ]);
  return [
    ...failures,
    ...results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    ),
  ];
}
