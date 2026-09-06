import type { ArtifactStore } from './store-port.js';
import type {
  ArtifactUploadDatabase as PersistedArtifactUploadDatabase,
  ArtifactUploadIdentity,
  ArtifactUploadResult,
  FinalizeArtifactUploadInput,
} from '@pertexo/database/api';
import type {
  ActorContext,
  AuthorizedWorkspaceContext,
  WorkspaceAuthorizationSource,
} from '../workspaces/index.js';

export type ArtifactRecord = ArtifactUploadResult['artifact'];

export type ArtifactIdentity = ArtifactUploadIdentity;

export type ArtifactDeclaredMetadata =
  FinalizeArtifactUploadInput['expectedMetadata'];

type ArtifactUploadOperations = Pick<
  PersistedArtifactUploadDatabase,
  'beginUpload' | 'getForUpload' | 'finalizeUpload' | 'getMetadata'
>;

export type ArtifactUploadDatabase = ArtifactUploadOperations &
  Pick<PersistedArtifactUploadDatabase, 'checkReadiness' | 'close'>;

export type ArtifactDependencies = Readonly<{
  database: ArtifactUploadOperations;
  authorization: WorkspaceAuthorizationSource;
  store: ArtifactStore;
}>;

export type ArtifactServiceContext = Readonly<{
  actor: ActorContext;
  routeWorkspaceId: string;
  authorizedWorkspace?: AuthorizedWorkspaceContext;
  signal?: AbortSignal;
}>;
