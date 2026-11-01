export {
  createNotificationDestinationStore,
  type NotificationDestinationStore,
} from './destinations/store.js';
export { FailureNotificationDestinationError } from './destinations/errors.js';
export {
  createFailureNotificationStore,
  type FailureNotificationStore,
} from './store.js';
export { FailureNotificationStateError } from './errors.js';
export type { FailureNotificationResolvedDestination } from './contract.js';

// Run acceptance and a run's completion use these directly (ADR 091).
export type {} from './policies/admission.queries.js';
export type {} from './delivery/evidence.repository.js';

export { createWorkspaceInboxDatabase } from '../inbox/threads/reader.repository.js';
export type {
  WorkspaceInboxCursor,
  WorkspaceInboxDatabase,
  WorkspaceInboxFailureKind,
  WorkspaceInboxSummary,
  WorkspaceInboxThreadPage,
  WorkspaceInboxThreadRecord,
} from '../inbox/threads/contract.js';
export { createWorkspaceInboxFoldStore } from '../inbox/folding/processor.repository.js';
export type {
  WorkspaceInboxChange,
  WorkspaceInboxFoldStore,
} from '../inbox/folding/contract.js';

export { createNoticePreferencesStore } from '../inbox/preferences/settings.repository.js';
export {
  NoticeConflictError,
  NoticeUnavailableError,
  type NoticePreferencesStore,
} from '../inbox/preferences/contract.js';

export { createNoticeMailStore } from '../inbox/mail/delivery.repository.js';
export type {
  NoticeMailStore,
  NoticeMailSealer,
  NoticeMailToSeal,
  NoticeMailItem,
} from '../inbox/mail/contract.js';
