export class ArtifactApiNotFoundError extends Error {
  public constructor() {
    super('Artifact was not found');
    this.name = 'ArtifactApiNotFoundError';
  }
}
export class ArtifactApiConflictError extends Error {
  public constructor(message = 'Artifact conflicts with its current state') {
    super(message);
    this.name = 'ArtifactApiConflictError';
  }
}
export class ArtifactApiUnavailableError extends Error {
  public constructor(message = 'Artifact storage is unavailable') {
    super(message);
    this.name = 'ArtifactApiUnavailableError';
  }
}
export class ArtifactUploadDeadlineError extends Error {
  public constructor() {
    super('Artifact upload deadline has passed');
    this.name = 'ArtifactUploadDeadlineError';
  }
}
export class ArtifactUploadTooLargeError extends Error {
  public constructor() {
    super('Artifact exceeds the configured object size limit');
    this.name = 'ArtifactUploadTooLargeError';
  }
}
