import {
  ArtifactInputIntegrityError,
  ArtifactIntegrityError,
} from '../errors.js';

import { safelyObserveSafetyViolation } from '../s3/telemetry.js';
import type { ObjectStoreObserver } from '../s3/telemetry.js';

import type {
  ArtifactDownloadCapability,
  BeginDirectDownloadRequest,
  DirectDownload,
} from '../download.js';

import type {
  ArtifactMetadata,
  PutArtifactRequest,
  ArtifactRequest,
  ArtifactDownload,
  BeginDirectUploadRequest,
  ValidateDirectUploadRequest,
  DirectUpload,
  ArtifactStoreReadiness,
  ArtifactStore,
  PurgeWorkspaceObjectsRequest,
  WorkspaceObjectPurgePage,
  WorkspaceObjectPurgeStore,
} from './contract.js';

export class ObservedArtifactStore
  implements
    ArtifactStore,
    ArtifactDownloadCapability,
    WorkspaceObjectPurgeStore
{
  public constructor(
    private readonly store: ArtifactStore &
      ArtifactDownloadCapability &
      WorkspaceObjectPurgeStore,
    private readonly observer: ObjectStoreObserver,
  ) {}

  public beginDirectUpload(
    request: BeginDirectUploadRequest,
  ): Promise<DirectUpload> {
    return this.observe(() => this.store.beginDirectUpload(request));
  }

  public beginDirectDownload(
    request: BeginDirectDownloadRequest,
  ): Promise<DirectDownload> {
    return this.observe(() => this.store.beginDirectDownload(request));
  }

  public checkReadiness(signal?: AbortSignal): Promise<ArtifactStoreReadiness> {
    return this.observe(() => this.store.checkReadiness(signal));
  }

  public close(): void {
    this.store.close();
  }

  public delete(request: ArtifactRequest): Promise<void> {
    return this.observe(() => this.store.delete(request));
  }

  public async getStream(request: ArtifactRequest): Promise<ArtifactDownload> {
    const download = await this.observe(() => this.store.getStream(request));
    download.body.once('error', (error: unknown) => {
      this.report(error);
    });
    return download;
  }

  public head(request: ArtifactRequest): Promise<ArtifactMetadata | null> {
    return this.observe(() => this.store.head(request));
  }

  public put(request: PutArtifactRequest): Promise<ArtifactMetadata> {
    return this.observe(() => this.store.put(request));
  }

  public purgeWorkspacePage(
    request: PurgeWorkspaceObjectsRequest,
  ): Promise<WorkspaceObjectPurgePage> {
    return this.observe(() => this.store.purgeWorkspacePage(request));
  }

  public validateDirectUpload(
    request: ValidateDirectUploadRequest,
  ): Promise<ArtifactMetadata> {
    return this.observe(() => this.store.validateDirectUpload(request));
  }

  private async observe<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      this.report(error);
      throw error;
    }
  }

  private report(error: unknown): void {
    try {
      if (
        !(error instanceof ArtifactIntegrityError) ||
        error instanceof ArtifactInputIntegrityError
      )
        return;
    } catch {
      return;
    }
    safelyObserveSafetyViolation(this.observer, {
      check: 'artifact_integrity',
    });
  }
}
