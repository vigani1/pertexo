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
