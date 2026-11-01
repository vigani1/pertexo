import type { ArtifactStore } from './store-port.js';
import type {
  ArtifactUploadDatabase as PersistedArtifactUploadDatabase,
  FormUploadDatabase as PersistedFormUploadDatabase,
  ArtifactUploadIdentity,
  ArtifactUploadResult,
  FinalizeArtifactUploadInput,
} from '@pertexo/core/runs';
import type {
  ActorContext,
  AuthorizedWorkspaceContext,
  WorkspaceAuthorizationSource,
} from '../authorization/index.js';

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

export type FormUploadDatabase = Pick<
  PersistedFormUploadDatabase,
  'discover' | 'begin' | 'read' | 'finalize'
>;

export type ArtifactDependencies = Readonly<{
  database: ArtifactUploadOperations;
  formUploads: FormUploadDatabase;
  authorization: WorkspaceAuthorizationSource;
  store: ArtifactStore;
}>;

/** The member artifact API needs neither form uploads nor their database. */
export type ArtifactServiceDependencies = Omit<
  ArtifactDependencies,
  'formUploads'
>;

export type ArtifactServiceContext = Readonly<{
  actor: ActorContext;
  routeWorkspaceId: string;
  authorizedWorkspace?: AuthorizedWorkspaceContext;
  signal?: AbortSignal;
}>;
