export {
  createFailureNotificationDestinationDatabase,
  FailureNotificationDestinationError,
} from './destinations/repository.js';
export type { FailureNotificationDestinationDatabase } from './destinations/contract.js';
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

export { createNoticePreferencesStore } from '../inbox/preferences/store.js';
export {
  NoticeConflictError,
  NoticeUnavailableError,
  type NoticePreferencesStore,
} from '../inbox/preferences/contract.js';

export { createNoticeMailStore } from '../inbox/mail/store.js';
export type {
  NoticeMailStore,
  NoticeMailSealer,
  NoticeMailToSeal,
  NoticeMailItem,
} from '../inbox/mail/contract.js';
