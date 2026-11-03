export class ArtifactQuotaExceededError extends Error {
  public readonly code = 'workspace.quota_exceeded' as const;

  public constructor() {
    super('workspace.quota_exceeded');
    this.name = 'ArtifactQuotaExceededError';
  }
}

export class ArtifactUploadConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ArtifactUploadConflictError';
  }
}

export class ArtifactUploadIdempotencyConflictError extends Error {
  public constructor() {
    super('request.idempotency_conflict');
    this.name = 'ArtifactUploadIdempotencyConflictError';
  }
}

export class ArtifactUploadNotFoundError extends Error {
  public constructor() {
    super('Artifact upload metadata was not found in the workspace');
    this.name = 'ArtifactUploadNotFoundError';
  }
}
