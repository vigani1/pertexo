import type { ArtifactStoreConfig } from './config.js';
import { artifactMetadataMatches } from './artifact-metadata.js';
import {
  createProductionObjectStoreObserver,
  safelyObserveSafetyViolation,
  type ObjectStoreObserver,
} from './object-store-telemetry.js';
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
import type {
  ArtifactDownloadCapability,
  BeginDirectDownloadRequest,
  DirectDownload,
} from './artifact-download.js';

type ArtifactStoreWithPurge = ArtifactStore & WorkspaceObjectPurgeStore;

export interface DualRegionArtifactStoreReadiness extends ArtifactStoreReadiness {
  readonly primary: ArtifactStoreReadiness;
  readonly recovery: ArtifactStoreReadiness;
}

export interface DualRegionArtifactStore
  extends ArtifactStoreWithPurge, ArtifactDownloadCapability {
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

function downloadCapability(
  store: ArtifactStoreWithPurge,
): ArtifactDownloadCapability {
  if (
    typeof (store as Partial<ArtifactDownloadCapability>)
      .beginDirectDownload !== 'function'
  ) {
    throw new TypeError('Artifact primary store must support direct downloads');
  }
  return store as ArtifactStoreWithPurge & ArtifactDownloadCapability;
}

class CoordinatedDualRegionArtifactStore implements DualRegionArtifactStore {
  private closed = false;

  public constructor(
    private readonly primary: ArtifactStoreWithPurge,
    private readonly recovery: ArtifactStoreWithPurge,
    private readonly ownsStores: boolean,
    private readonly observer: ObjectStoreObserver,
  ) {}

  private observe(
    check:
      | 'artifact_integrity'
      | 'artifact_replication'
      | 'artifact_read_consistency'
      | 'artifact_purge_consistency'
      | 'region_isolation',
    operation: 'readiness' | 'delete' | 'purge' | 'replicate' | 'verify',
    outcome: 'diverged' | 'partial' | 'unavailable',
    failedRegionRole: 'primary' | 'recovery' | 'both' | 'none',
  ): void {
    safelyObserveSafetyViolation(this.observer, {
      check,
      failedRegionRole,
      operation,
      outcome,
      regionRole: 'primary',
      surface: 'artifact',
    });
  }

  public beginDirectUpload(
    request: BeginDirectUploadRequest,
  ): Promise<DirectUpload> {
    this.assertOpen();
    return this.primary.beginDirectUpload(request);
  }

  public beginDirectDownload(
    request: BeginDirectDownloadRequest,
  ): Promise<DirectDownload> {
    this.assertOpen();
    return downloadCapability(this.primary).beginDirectDownload(request);
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
    if (primary.status === 'rejected' || recovery.status === 'rejected') {
      this.observe(
        'artifact_read_consistency',
        'readiness',
        'unavailable',
        primary.status === 'rejected' && recovery.status === 'rejected'
          ? 'both'
          : primary.status === 'rejected'
            ? 'primary'
            : 'recovery',
      );
      throw new ArtifactIntegrityError(
        'Dual-region artifact readiness could not be verified',
      );
    }
    if (
      primary.value.bucket === recovery.value.bucket ||
      primary.value.region === recovery.value.region
    ) {
      this.observe('region_isolation', 'readiness', 'diverged', 'both');
      throw new ArtifactIntegrityError(
        'Artifact primary and recovery regions and buckets must be distinct',
      );
    }
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
    const failures: unknown[] = [];
    try {
      this.primary.close();
    } catch (error: unknown) {
      failures.push(error);
    }
    try {
      this.recovery.close();
    } catch (error: unknown) {
      failures.push(error);
    }
    if (failures.length > 0)
      throw new AggregateError(failures, 'Failed to close artifact stores');
  }

  public async delete(request: ArtifactRequest): Promise<void> {
    this.assertOpen();
    const deleted = await Promise.allSettled([
      this.primary.delete(request),
      this.recovery.delete(request),
    ]);
    if (deleted.some((result) => result.status === 'rejected')) {
      this.observe(
        'artifact_replication',
        'delete',
        'partial',
        deleted.every((result) => result.status === 'rejected')
          ? 'both'
          : deleted[0].status === 'rejected'
            ? 'primary'
            : 'recovery',
      );
      throw new ArtifactPartialReplicationError();
    }
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
    if (purged[0].status === 'rejected' || purged[1].status === 'rejected') {
      this.observe(
        'artifact_purge_consistency',
        'purge',
        'unavailable',
        purged[0].status === 'rejected' && purged[1].status === 'rejected'
          ? 'both'
          : purged[0].status === 'rejected'
            ? 'primary'
            : 'recovery',
      );
      throw new ArtifactPartialReplicationError();
    }
    if (
      purged[0].value.completed !== purged[1].value.completed ||
      purged[0].value.deletedCount !== purged[1].value.deletedCount
    ) {
      this.observe('artifact_purge_consistency', 'purge', 'diverged', 'both');
      throw new ArtifactIntegrityError(
        'Artifact primary and recovery purge results differ',
      );
    }
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
      if (!artifactMetadataMatches(existing, expected))
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
    if (
      verified[0].status === 'rejected' ||
      verified[1].status === 'rejected'
    ) {
      this.observe(
        'artifact_read_consistency',
        'verify',
        'unavailable',
        verified[0].status === 'rejected' && verified[1].status === 'rejected'
          ? 'both'
          : verified[0].status === 'rejected'
            ? 'primary'
            : 'recovery',
      );
      throw new ArtifactIntegrityError(
        'Artifact replicas could not both be checksum-validated',
      );
    }
    if (!artifactMetadataMatches(verified[0].value, verified[1].value)) {
      this.observe('artifact_read_consistency', 'verify', 'diverged', 'both');
      throw new ArtifactIntegrityError('Artifact replica metadata differs');
    }
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
      if (!artifactMetadataMatches(existing, metadata))
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
      this.observe('artifact_replication', 'replicate', 'partial', 'recovery');
      throw new ArtifactPartialReplicationError();
    }
  }
}

export function createDualRegionArtifactStore(
  primary: ArtifactStoreConfig | ArtifactStoreWithPurge,
  recovery: ArtifactStoreConfig | ArtifactStoreWithPurge,
  options: Readonly<{
    artifactOwnership?: 'borrowed' | 'owned';
    observer?: ObjectStoreObserver;
  }> = {},
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
    : createArtifactStore(primary, {
        ...(options.observer === undefined
          ? {}
          : { observer: options.observer }),
        regionRole: 'primary',
      });
  const recoveryStore = isArtifactStore(recovery)
    ? recovery
    : createArtifactStore(recovery, {
        ...(options.observer === undefined
          ? {}
          : { observer: options.observer }),
        regionRole: 'recovery',
      });
  return new CoordinatedDualRegionArtifactStore(
    primaryStore,
    recoveryStore,
    injected ? options.artifactOwnership === 'owned' : true,
    options.observer ?? createProductionObjectStoreObserver(),
  );
}
