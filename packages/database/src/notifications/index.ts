export {
  createFailureNotificationDestinationDatabase,
  FailureNotificationDestinationError,
} from './destinations/repository.js';
export type { FailureNotificationDestinationDatabase } from './destinations/repository.js';
export {
  createFailureNotificationStore,
  FailureNotificationStateError,
} from './store.js';
export type {
  FailureNotificationResolvedDestination,
  FailureNotificationStore,
} from './store.js';

export { createWorkspaceInboxDatabase } from '../inbox/read-store.js';
export type {
  WorkspaceInboxCursor,
  WorkspaceInboxDatabase,
  WorkspaceInboxFailureKind,
  WorkspaceInboxSummary,
  WorkspaceInboxThreadPage,
  WorkspaceInboxThreadRecord,
} from '../inbox/read-store.js';
export { createWorkspaceInboxFoldStore } from '../inbox/fold-store.js';
export type {
  WorkspaceInboxChange,
  WorkspaceInboxFoldStore,
} from '../inbox/fold-store.js';
