export class IdempotencyRequestConflictError extends Error {
  public override readonly name = 'IdempotencyRequestConflictError';

  public constructor() {
    super('request.idempotency_conflict');
  }
}

export class IdempotencyRecordCorruptError extends Error {
  public override readonly name = 'IdempotencyRecordCorruptError';

  public constructor() {
    super('Persisted workflow run acceptance is incomplete or invalid');
  }
}

export class WorkspaceRunAdmissionDeniedError extends Error {
  public override readonly name = 'WorkspaceRunAdmissionDeniedError';

  public constructor() {
    super('workspace.run_admission_denied');
  }
}

export class WorkspaceRunQuotaExceededError extends Error {
  public override readonly name = 'WorkspaceRunQuotaExceededError';
  public readonly retryAfterSeconds = 5;

  public constructor() {
    super('workspace.quota_exceeded');
  }
}

export class WorkflowAlreadyRunningError extends Error {
  override readonly name = 'WorkflowAlreadyRunningError';
  constructor() {
    super('This workflow is already running. Try again shortly.');
  }
}
