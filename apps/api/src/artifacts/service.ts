import {
  artifactFinalizeRequestSchema,
  artifactUploadRequestSchema,
  type ArtifactDownloadResponse,
  type ArtifactMetadataResponse,
  type ArtifactUploadResponse,
} from '@pertexo/contracts';

import {
  authorizeWorkspaceOperation,
  type AuthorizationCapability,
} from '../authorization/index.js';
import {
  ArtifactApiConflictError,
  ArtifactApiNotFoundError,
  ArtifactUploadDeadlineError,
} from './errors.js';
import {
  assertUploadSize,
  signArtifactUpload,
  storageFailure,
  verifyDirectUpload,
} from './transfer.js';
import type {
  ArtifactDeclaredMetadata,
  ArtifactDependencies,
  ArtifactServiceDependencies,
  ArtifactIdentity,
  ArtifactRecord,
  ArtifactServiceContext,
} from './ports.js';

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
    private readonly dependencies: ArtifactServiceDependencies,
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
    assertUploadSize(metadata.byteLength, this.options.maxObjectBytes);
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
      throw storageFailure(error, 'database');
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
    const upload = await signArtifactUpload(
      this.dependencies.store,
      artifact,
      this.now(),
      input.signal,
    );
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
      throw storageFailure(error, 'database');
    }
    if (artifact === null) throw new ArtifactApiNotFoundError();
    if (artifact.status === 'available') return publicMetadata(artifact);
    if (artifact.status !== 'pending') throw new ArtifactApiConflictError();
    if (artifact.expiresAt.getTime() <= this.now().getTime())
      throw new ArtifactUploadDeadlineError();

    assertUploadSize(artifact.byteLength, this.options.maxObjectBytes);
    const expected = declaredMetadata(artifact);
    try {
      const finalized = await this.dependencies.database.finalizeUpload({
        actor: input.actor,
        expectedMetadata: expected,
        identity,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        verifyUpload: async () => {
          await verifyDirectUpload(
            this.dependencies.store,
            artifact,
            input.signal,
          );
          // Verification may take long enough for membership to change.
          await this.authorize(input, 'artifact:upload', undefined);
        },
      });
      return publicMetadata(finalized);
    } catch (error: unknown) {
      throw storageFailure(error, 'database');
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
      throw storageFailure(error, 'store');
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
      throw storageFailure(error, 'database');
    }
    if (artifact?.status !== 'pending' && artifact?.status !== 'available')
      throw new ArtifactApiNotFoundError();
    return artifact;
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
