export const ARTIFACT_STATUS = {
  available: 'available',
  deleted: 'deleted',
  deleting: 'deleting',
  pending: 'pending',
} as const;

export class ArtifactFinalizeConflictError extends Error {
  public constructor() {
    super('Validated object metadata does not match the pending artifact');
    this.name = 'ArtifactFinalizeConflictError';
  }
}

export class ArtifactLifecycleConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ArtifactLifecycleConflictError';
  }
}

export class ArtifactMetadataNotFoundError extends Error {
  public constructor() {
    super('Artifact metadata was not found in the workspace');
    this.name = 'ArtifactMetadataNotFoundError';
  }
}
