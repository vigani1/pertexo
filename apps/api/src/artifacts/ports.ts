import type { ArtifactStore } from './store-port.js';
import type {
  ArtifactUploadStore as PersistedArtifactUploadStore,
  FormUploadStore as PersistedFormUploadStore,
  ArtifactUploadIdentity,
  ArtifactUploadResult,
  FinalizeArtifactUploadInput,
} from '@pertexo/core/artifacts';
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
  PersistedArtifactUploadStore,
  'beginUpload' | 'getForUpload' | 'finalizeUpload' | 'getMetadata'
>;

export type ArtifactUploadStore = ArtifactUploadOperations &
  Pick<PersistedArtifactUploadStore, 'checkReadiness' | 'close'>;

export type FormUploadStore = Pick<
  PersistedFormUploadStore,
  'discover' | 'begin' | 'read' | 'finalize'
>;

export type ArtifactDependencies = Readonly<{
  database: ArtifactUploadOperations;
  formUploads: FormUploadStore;
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
