import type { PutObjectCommand } from '@aws-sdk/client-s3';

import type { Readable } from 'node:stream';

import type { ArtifactIdentity } from '../identity.js';

import type { ObjectStoreS3Client } from '../s3/contract.js';

export type S3ClientLike = ObjectStoreS3Client;

export interface ArtifactMetadata extends ArtifactIdentity {
  readonly byteLength: number;
  readonly mediaType: string;
  readonly sha256: string;
}

export interface PutArtifactRequest extends ArtifactMetadata {
  /** Ownership transfers only after the store admits the request preflight. */
  readonly body: Readable;
  readonly signal?: AbortSignal;
}

export interface ArtifactRequest extends ArtifactIdentity {
  readonly signal?: AbortSignal;
}

export interface ArtifactDownload {
  readonly body: Readable;
  readonly metadata: ArtifactMetadata;
}

export interface BeginDirectUploadRequest extends ArtifactMetadata {
  readonly expiresInSeconds: number;
  readonly signal?: AbortSignal;
}

export interface ValidateDirectUploadRequest extends ArtifactMetadata {
  readonly signal?: AbortSignal;
}

export interface DirectUpload {
  readonly expiresAt: string;
  readonly expiresInSeconds: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: 'PUT';
  readonly url: string;
}

export interface PutObjectPresignRequest {
  readonly command: PutObjectCommand;
  readonly expiresInSeconds: number;
  readonly signal: AbortSignal;
  readonly signableHeaders: ReadonlySet<string>;
  readonly unhoistableHeaders: ReadonlySet<string>;
}

export type PutObjectPresigner = (
  request: PutObjectPresignRequest,
) => Promise<string>;

export interface ArtifactStoreReadiness {
  readonly bucket: string;
  readonly region: string;
}

export interface ArtifactStore {
  beginDirectUpload(request: BeginDirectUploadRequest): Promise<DirectUpload>;
  checkReadiness(signal?: AbortSignal): Promise<ArtifactStoreReadiness>;
  close(): void;
  delete(request: ArtifactRequest): Promise<void>;
  getStream(request: ArtifactRequest): Promise<ArtifactDownload>;
  head(request: ArtifactRequest): Promise<ArtifactMetadata | null>;
  put(request: PutArtifactRequest): Promise<ArtifactMetadata>;
  validateDirectUpload(
    request: ValidateDirectUploadRequest,
  ): Promise<ArtifactMetadata>;
}

export interface PurgeWorkspaceObjectsRequest {
  readonly maxObjects: number;
  readonly signal?: AbortSignal;
  readonly workspaceId: string;
}

export interface WorkspaceObjectPurgePage {
  readonly completed: boolean;
  readonly deletedCount: number;
}

export interface WorkspaceObjectPurgeStore {
  purgeWorkspacePage(
    request: PurgeWorkspaceObjectsRequest,
  ): Promise<WorkspaceObjectPurgePage>;
}

export interface Destroyable {
  destroy(): void;
}
