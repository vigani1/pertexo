import type { ArtifactStoreConfig } from './config.js';
import {
  ArtifactIntegrityError,
  ArtifactStoreClosedError,
  createArtifactStore,
  type ArtifactDownload,
  type ArtifactMetadata,
  type ArtifactRequest,
  type ArtifactStore,
  type ArtifactStoreReadiness,
  type BeginDirectUploadRequest,
  type DirectUpload,
  type PurgeWorkspaceObjectsRequest,
  type PutArtifactRequest,
  type ValidateDirectUploadRequest,
  type WorkspaceObjectPurgePage,
  type WorkspaceObjectPurgeStore,
} from './store.js';

type ArtifactStoreWithPurge = ArtifactStore & WorkspaceObjectPurgeStore;

export interface DualRegionArtifactStoreReadiness extends ArtifactStoreReadiness {
  readonly primary: ArtifactStoreReadiness;
  readonly recovery: ArtifactStoreReadiness;
}

export interface DualRegionArtifactStore extends ArtifactStoreWithPurge {
  checkReadiness(
    signal?: AbortSignal,
  ): Promise<DualRegionArtifactStoreReadiness>;
  verifyReplicas(
    request: ValidateDirectUploadRequest,
  ): Promise<ArtifactMetadata>;
}

export class ArtifactPartialReplicationError extends Error {
  public constructor() {
    super(
      'Artifact write was only partially replicated; retry the exact artifact',
    );
    this.name = 'ArtifactPartialReplicationError';
  }
}

function metadataMatches(
  actual: ArtifactMetadata,
  expected: ArtifactMetadata,
): boolean {
  return (
    actual.artifactId === expected.artifactId &&
    actual.workspaceId === expected.workspaceId &&
    actual.byteLength === expected.byteLength &&
    actual.mediaType === expected.mediaType &&
    actual.sha256 === expected.sha256
  );
}

function isArtifactStore(value: unknown): value is ArtifactStoreWithPurge {
  return (
    typeof value === 'object' &&
    value !== null &&
    'beginDirectUpload' in value &&
    typeof value.beginDirectUpload === 'function' &&
    'purgeWorkspacePage' in value &&
    typeof value.purgeWorkspacePage === 'function'
  );
}

class CoordinatedDualRegionArtifactStore implements DualRegionArtifactStore {
  private closed = false;

  public constructor(
    private readonly primary: ArtifactStoreWithPurge,
    private readonly recovery: ArtifactStoreWithPurge,
    private readonly ownsStores: boolean,
  ) {}

  public beginDirectUpload(
    request: BeginDirectUploadRequest,
  ): Promise<DirectUpload> {
    this.assertOpen();
    return this.primary.beginDirectUpload(request);
  }

  public async checkReadiness(
    signal?: AbortSignal,
  ): Promise<DualRegionArtifactStoreReadiness> {
    this.assertOpen();
    const [primary, recovery] = await Promise.allSettled([
      this.primary.checkReadiness(signal),
      this.recovery.checkReadiness(signal),
    ]);
    signal?.throwIfAborted();
    if (primary.status === 'rejected' || recovery.status === 'rejected')
      throw new ArtifactIntegrityError(
        'Dual-region artifact readiness could not be verified',
      );
    if (
      primary.value.bucket === recovery.value.bucket ||
      primary.value.region === recovery.value.region
    )
      throw new ArtifactIntegrityError(
        'Artifact primary and recovery regions and buckets must be distinct',
      );
    return Object.freeze({
      bucket: primary.value.bucket,
      primary: primary.value,
      recovery: recovery.value,
      region: primary.value.region,
    });
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.ownsStores) return;
    this.primary.close();
    this.recovery.close();
  }

  public async delete(request: ArtifactRequest): Promise<void> {
    this.assertOpen();
    const deleted = await Promise.allSettled([
      this.primary.delete(request),
      this.recovery.delete(request),
    ]);
    if (deleted.some((result) => result.status === 'rejected'))
      throw new ArtifactPartialReplicationError();
  }

  public getStream(request: ArtifactRequest): Promise<ArtifactDownload> {
    this.assertOpen();
    return this.primary.getStream(request);
  }

  public head(request: ArtifactRequest): Promise<ArtifactMetadata | null> {
    this.assertOpen();
    return this.primary.head(request);
  }

  public async purgeWorkspacePage(
    request: PurgeWorkspaceObjectsRequest,
  ): Promise<WorkspaceObjectPurgePage> {
    this.assertOpen();
    const purged = await Promise.allSettled([
      this.primary.purgeWorkspacePage(request),
      this.recovery.purgeWorkspacePage(request),
    ]);
    if (purged[0].status === 'rejected' || purged[1].status === 'rejected')
      throw new ArtifactPartialReplicationError();
    if (
      purged[0].value.completed !== purged[1].value.completed ||
      purged[0].value.deletedCount !== purged[1].value.deletedCount
    )
      throw new ArtifactIntegrityError(
        'Artifact primary and recovery purge results differ',
      );
    return purged[0].value;
  }

  public async put(request: PutArtifactRequest): Promise<ArtifactMetadata> {
    this.assertOpen();
    const expected: ArtifactMetadata = Object.freeze({
      artifactId: request.artifactId,
      byteLength: request.byteLength,
      mediaType: request.mediaType,
      sha256: request.sha256,
      workspaceId: request.workspaceId,
    });
    const existing = await this.primary.head(request);
    if (existing === null) {
      await this.primary.put(request);
    } else {
      request.body.destroy();
      if (!metadataMatches(existing, expected))
        throw new ArtifactIntegrityError(
          'Primary artifact conflicts with the requested immutable artifact',
        );
    }
    await this.replicateFromPrimary(expected, request.signal);
    return this.verifyReplicas(request);
  }

  public async validateDirectUpload(
    request: ValidateDirectUploadRequest,
  ): Promise<ArtifactMetadata> {
    this.assertOpen();
    const expected = await this.primary.validateDirectUpload(request);
    await this.replicateFromPrimary(expected, request.signal);
    return this.verifyReplicas(request);
  }

  public async verifyReplicas(
    request: ValidateDirectUploadRequest,
  ): Promise<ArtifactMetadata> {
    this.assertOpen();
    const verified = await Promise.allSettled([
      this.primary.validateDirectUpload(request),
      this.recovery.validateDirectUpload(request),
    ]);
    if (verified[0].status === 'rejected' || verified[1].status === 'rejected')
      throw new ArtifactIntegrityError(
        'Artifact replicas could not both be checksum-validated',
      );
    if (!metadataMatches(verified[0].value, verified[1].value))
      throw new ArtifactIntegrityError('Artifact replica metadata differs');
    return verified[0].value;
  }

  private assertOpen(): void {
    if (this.closed) throw new ArtifactStoreClosedError();
  }

  private async replicateFromPrimary(
    metadata: ArtifactMetadata,
    signal?: AbortSignal,
  ): Promise<void> {
    const existing = await this.recovery.head({
      artifactId: metadata.artifactId,
      workspaceId: metadata.workspaceId,
      ...(signal === undefined ? {} : { signal }),
    });
    if (existing !== null) {
      if (!metadataMatches(existing, metadata))
        throw new ArtifactIntegrityError(
          'Recovery artifact conflicts with the primary artifact',
        );
      return;
    }
    try {
      const download = await this.primary.getStream({
        artifactId: metadata.artifactId,
        workspaceId: metadata.workspaceId,
        ...(signal === undefined ? {} : { signal }),
      });
      await this.recovery.put({
        ...metadata,
        body: download.body,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error: unknown) {
      if (error instanceof ArtifactIntegrityError) throw error;
      throw new ArtifactPartialReplicationError();
    }
  }
}

export function createDualRegionArtifactStore(
  primary: ArtifactStoreConfig | ArtifactStoreWithPurge,
  recovery: ArtifactStoreConfig | ArtifactStoreWithPurge,
  options: Readonly<{ artifactOwnership?: 'borrowed' | 'owned' }> = {},
): DualRegionArtifactStore {
  const injected = isArtifactStore(primary) && isArtifactStore(recovery);
  if (isArtifactStore(primary) !== isArtifactStore(recovery))
    throw new TypeError(
      'Artifact primary and recovery must both be configs or both be stores',
    );
  if (injected && options.artifactOwnership === undefined)
    throw new TypeError('Injected artifact stores require explicit ownership');
  const primaryStore = isArtifactStore(primary)
    ? primary
    : createArtifactStore(primary, { regionRole: 'primary' });
  const recoveryStore = isArtifactStore(recovery)
    ? recovery
    : createArtifactStore(recovery, { regionRole: 'recovery' });
  return new CoordinatedDualRegionArtifactStore(
    primaryStore,
    recoveryStore,
    injected ? options.artifactOwnership === 'owned' : true,
  );
}
