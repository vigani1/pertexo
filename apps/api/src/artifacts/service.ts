import {
  ArtifactIntegrityError,
  ArtifactNotFoundError,
} from '@pertexo/artifact-store';
import {
  ArtifactQuotaExceededError,
  ArtifactUploadConflictError,
  ArtifactUploadIdempotencyConflictError,
  ArtifactUploadNotFoundError,
} from '@pertexo/database/api';
import {
  artifactFinalizeRequestSchema,
  artifactUploadRequestSchema,
  type ArtifactDownloadResponse,
  type ArtifactMetadataResponse,
  type ArtifactUploadResponse,
} from '@pertexo/contracts/artifacts';

import {
  authorizeWorkspaceOperation,
  type AuthorizationCapability,
} from '../workspaces/index.js';
import {
  ArtifactApiCapacityExceededError,
  ArtifactApiConflictError,
  ArtifactApiIdempotencyConflictError,
  ArtifactApiNotFoundError,
  ArtifactApiUnavailableError,
  ArtifactUploadDeadlineError,
  ArtifactUploadTooLargeError,
} from './errors.js';
import type {
  ArtifactDeclaredMetadata,
  ArtifactDependencies,
  ArtifactIdentity,
  ArtifactRecord,
  ArtifactServiceContext,
} from './ports.js';

const MIN_SIGNER_TTL_SECONDS = 60;
const MAX_SIGNER_TTL_SECONDS = 900;
const DOWNLOAD_TTL_SECONDS = 60;

export type ArtifactServiceOptions = Readonly<{
  maxObjectBytes: number;
  now?: () => Date;
}>;

type UploadOperation = ArtifactServiceContext &
  Readonly<{ request: unknown; idempotencyKey: string }>;
type FinalizeOperation = ArtifactServiceContext &
  Readonly<{ request: unknown }>;

export class ArtifactService {
  private readonly now: () => Date;

  public constructor(
    private readonly dependencies: ArtifactDependencies,
    private readonly options: ArtifactServiceOptions,
  ) {
    if (
      !Number.isSafeInteger(options.maxObjectBytes) ||
      options.maxObjectBytes <= 0
    )
      throw new TypeError(
        'artifact maxObjectBytes must be a positive safe integer',
      );
    this.now = options.now ?? (() => new Date());
  }

  public async beginUpload(
    input: UploadOperation,
  ): Promise<ArtifactUploadResponse> {
    const authorization = await this.authorize(
      input,
      'artifact:upload',
      input.authorizedWorkspace,
    );
    const metadata = artifactUploadRequestSchema.parse(input.request);
    this.assertSize(metadata.byteLength);
    let created: Awaited<
      ReturnType<ArtifactDependencies['database']['beginUpload']>
    >;
    try {
      created = await this.dependencies.database.beginUpload({
        ...metadata,
        actor: input.actor,
        idempotencyKey: input.idempotencyKey,
        workspaceId: authorization.workspaceId,
      });
    } catch (error: unknown) {
      throw mapDatabaseError(error);
    }

    const artifact = created.artifact;
    if (artifact.status === 'available') {
      // A completed identity is immutable. The public response shape carries
      // a PUT capability only for pending reservations, so never mint a new
      // capability after finalization.
      throw new ArtifactApiConflictError(
        'Artifact upload has already been finalized',
      );
    }
    if (artifact.status !== 'pending') throw new ArtifactApiConflictError();
    const upload = await this.signUpload(artifact, input.signal);
    return Object.freeze({
      artifact: Object.freeze({
        ...publicMetadata(artifact),
        status: 'pending',
        expiresAt: artifact.expiresAt.toISOString(),
      }),
      upload,
      replayed: created.replayed,
    });
  }

  public async finalizeUpload(
    input: FinalizeOperation & Readonly<{ artifactId: string }>,
  ): Promise<ArtifactMetadataResponse> {
    const identity = this.identity(input.routeWorkspaceId, input.artifactId);
    await this.authorize(input, 'artifact:upload', input.authorizedWorkspace);
    artifactFinalizeRequestSchema.parse(input.request);
    let artifact: ArtifactRecord | null;
    try {
      artifact = await this.dependencies.database.getForUpload({
        actor: input.actor,
        identity,
      });
    } catch (error: unknown) {
      throw mapDatabaseError(error);
    }
    if (artifact === null) throw new ArtifactApiNotFoundError();
    if (artifact.status === 'available') return publicMetadata(artifact);
    if (artifact.status !== 'pending') throw new ArtifactApiConflictError();
    if (artifact.expiresAt.getTime() <= this.now().getTime())
      throw new ArtifactUploadDeadlineError();

    const expected = declaredMetadata(artifact);
    try {
      await this.dependencies.store.validateDirectUpload({
        artifactId: identity.artifactId,
        byteLength: expected.byteLength,
        mediaType: expected.mediaType,
        sha256: expected.sha256,
        workspaceId: identity.workspaceId,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (error: unknown) {
      throw mapStoreError(error);
    }

    // The external verification above may take long enough for membership or
    // lifecycle state to change. Re-authorize before the short CAS transaction.
    await this.authorize(input, 'artifact:upload', undefined);
    try {
      const finalized = await this.dependencies.database.finalizeUpload({
        actor: input.actor,
        expectedMetadata: expected,
        identity,
      });
      return publicMetadata(finalized);
    } catch (error: unknown) {
      throw mapDatabaseError(error);
    }
  }

  public async getMetadata(
    input: ArtifactServiceContext & Readonly<{ artifactId: string }>,
  ): Promise<ArtifactMetadataResponse> {
    return publicMetadata(await this.readAuthorizedArtifact(input));
  }

  public async beginDownload(
    input: ArtifactServiceContext & Readonly<{ artifactId: string }>,
  ): Promise<ArtifactDownloadResponse> {
    const identity = this.identity(input.routeWorkspaceId, input.artifactId);
    const artifact = await this.readAuthorizedArtifact(input);
    if (artifact.status !== 'available') throw new ArtifactApiNotFoundError();
    try {
      return await this.dependencies.store.beginDirectDownload({
        artifactId: identity.artifactId,
        expiresInSeconds: DOWNLOAD_TTL_SECONDS,
        workspaceId: identity.workspaceId,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (error: unknown) {
      throw mapStoreError(error);
    }
  }

  private async readAuthorizedArtifact(
    input: ArtifactServiceContext & Readonly<{ artifactId: string }>,
  ): Promise<ArtifactRecord> {
    await this.authorize(input, 'artifact:read', input.authorizedWorkspace);
    let artifact: ArtifactRecord | null;
    try {
      artifact = await this.dependencies.database.getMetadata({
        actor: input.actor,
        identity: this.identity(input.routeWorkspaceId, input.artifactId),
      });
    } catch (error: unknown) {
      throw mapDatabaseError(error);
    }
    if (artifact?.status !== 'pending' && artifact?.status !== 'available')
      throw new ArtifactApiNotFoundError();
    return artifact;
  }

  private async signUpload(artifact: ArtifactRecord, signal?: AbortSignal) {
    const remaining = Math.floor(
      (artifact.expiresAt.getTime() - this.now().getTime()) / 1_000,
    );
    if (remaining < MIN_SIGNER_TTL_SECONDS)
      throw new ArtifactUploadDeadlineError();
    try {
      return await this.dependencies.store.beginDirectUpload({
        artifactId: artifact.id,
        byteLength: artifact.byteLength,
        expiresInSeconds: Math.min(MAX_SIGNER_TTL_SECONDS, remaining),
        mediaType: artifact.mediaType,
        sha256: artifact.sha256,
        workspaceId: artifact.workspaceId,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error: unknown) {
      throw mapStoreError(error);
    }
  }

  private async authorize(
    input: ArtifactServiceContext,
    capability: AuthorizationCapability,
    authorizedWorkspace: ArtifactServiceContext['authorizedWorkspace'],
  ) {
    return authorizeWorkspaceOperation({
      access: this.dependencies.authorization,
      actor: input.actor,
      ...(authorizedWorkspace === undefined ? {} : { authorizedWorkspace }),
      capability,
      routeWorkspaceId: input.routeWorkspaceId,
    });
  }

  private assertSize(byteLength: number): void {
    if (byteLength > this.options.maxObjectBytes)
      throw new ArtifactUploadTooLargeError();
  }

  private identity(workspaceId: string, artifactId: string): ArtifactIdentity {
    return Object.freeze({ artifactId, workspaceId });
  }
}

function declaredMetadata(artifact: ArtifactRecord): ArtifactDeclaredMetadata {
  return Object.freeze({
    byteLength: artifact.byteLength,
    mediaType: artifact.mediaType,
    sha256: artifact.sha256,
  });
}

function publicMetadata(artifact: ArtifactRecord): ArtifactMetadataResponse {
  return Object.freeze({
    byteLength: artifact.byteLength,
    createdAt: artifact.createdAt.toISOString(),
    expiresAt:
      artifact.status === 'pending' ? artifact.expiresAt.toISOString() : null,
    id: artifact.id,
    mediaType: artifact.mediaType,
    sha256: artifact.sha256,
    status: artifact.status === 'available' ? 'available' : 'pending',
    workspaceId: artifact.workspaceId,
  });
}

function mapDatabaseError(error: unknown): Error {
  if (
    error instanceof ArtifactApiNotFoundError ||
    error instanceof ArtifactApiConflictError ||
    error instanceof ArtifactApiIdempotencyConflictError ||
    error instanceof ArtifactApiCapacityExceededError ||
    error instanceof ArtifactApiUnavailableError
  )
    return error;
  if (error instanceof ArtifactQuotaExceededError)
    return new ArtifactApiCapacityExceededError();
  if (error instanceof ArtifactUploadNotFoundError)
    return new ArtifactApiNotFoundError();
  if (error instanceof ArtifactUploadIdempotencyConflictError)
    return new ArtifactApiIdempotencyConflictError();
  if (error instanceof ArtifactUploadConflictError)
    return new ArtifactApiConflictError();
  return new ArtifactApiUnavailableError();
}

function mapStoreError(error: unknown): Error {
  if (
    error instanceof ArtifactIntegrityError ||
    error instanceof ArtifactNotFoundError
  )
    return new ArtifactApiConflictError();
  return new ArtifactApiUnavailableError();
}
