import { postgresFailure } from '@pertexo/database/primitives';

export class WorkspaceRunAdmissionDeniedError extends Error {
  public override readonly name = 'WorkspaceRunAdmissionDeniedError';

  public constructor() {
    super('workspace.run_admission_denied');
  }
}

/** When a caller over the run quota may try again. */
const RUN_CAPACITY_RETRY_AFTER_SECONDS = 5;

export class WorkspaceRunQuotaExceededError extends Error {
  public override readonly name = 'WorkspaceRunQuotaExceededError';
  public readonly retryAfterSeconds = RUN_CAPACITY_RETRY_AFTER_SECONDS;

  public constructor() {
    super('workspace.quota_exceeded');
  }
}

export class WorkflowAlreadyRunningError extends Error {
  override readonly name = 'WorkflowAlreadyRunningError';
  readonly retryAfterSeconds = RUN_CAPACITY_RETRY_AFTER_SECONDS;
  constructor() {
    super('This workflow is already running. Try again shortly.');
  }
}

export class RunVariableSnapshotUnavailableError extends Error {
  override readonly name = 'RunVariableSnapshotUnavailableError';
  constructor() {
    super(
      'The source run’s workspace variables have expired. Start a new run to use current values.',
    );
  }
}

export class RunRequiresFormError extends Error {
  override readonly name = 'RunRequiresFormError';
}

/** Run admission's SQLSTATEs as its errors; anything else is rethrown unchanged. */
export function throwWorkflowRunAdmissionError(error: unknown): never {
  const { code } = postgresFailure(error);
  if (code === 'PTA02') throw new WorkspaceRunQuotaExceededError();
  if (code === 'PTA01') throw new WorkspaceRunAdmissionDeniedError();
  throw error;
}
