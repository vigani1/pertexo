export { DELIVERY_CONSUMER } from './delivery-consumers.js';
export { createOutboxDispatcherDatabase } from './dispatcher/outbox-dispatcher.store.js';
export type {
  LeasedOutboxEvent,
  OutboxDispatcherDatabase,
} from './dispatcher/outbox-dispatcher.types.js';
export {
  InboxChecksumMismatchError,
  InboxReceiptUnavailableError,
} from './outbox.errors.js';
export { canonicalOutboxPayloadChecksum } from '@pertexo/database/primitives';

// Other areas import these files directly (ADR 091); the door gains nothing.
export type {} from './consume-message.js';
export type {} from './dispatcher/outbox-dispatcher.types.js';
export type {} from './dispatcher/outbox-dispatcher.store.js';
export type {} from './overdue-deliveries.repository.js';
export type {} from './retention.repository.js';

export type {} from './enqueue-delivery.repository.js';

export type {} from './overdue-delivery.js';

export type {} from './run-advance.repository.js';
