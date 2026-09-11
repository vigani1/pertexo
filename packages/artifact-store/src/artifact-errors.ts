export class ArtifactIntegrityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ArtifactIntegrityError';
  }
}

export class ArtifactInputIntegrityError extends ArtifactIntegrityError {}

export class ArtifactNotFoundError extends Error {
  public constructor() {
    super('Artifact was not found');
    this.name = 'ArtifactNotFoundError';
  }
}

export class ArtifactStoreClosedError extends Error {
  public constructor() {
    super('Artifact store is closed');
    this.name = 'ArtifactStoreClosedError';
  }
}
