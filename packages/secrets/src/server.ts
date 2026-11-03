export { createEncryptionKeyRepository } from './encryption/keys.repository.js';
export type { EncryptionKeyRepository } from './encryption/keys.repository.js';
export { insertSystemMail } from './mail/deliveries.repository.js';
export {
  verifySystemMailKeys,
  createSystemMailDeliveryStore,
  createSystemMailEnqueueStore,
  type SystemMailDeliveryStore,
  type SystemMailEnqueueStore,
} from './mail/system-mail.store.js';
export type {
  SealedSystemMailPayload,
  SystemMailDeliveryClaim,
  SystemMailInput,
  SystemMailPurpose,
} from './mail/system-mail.types.js';
export { authenticationMailAssociatedData } from './mail/mail-associated-data.js';

export { createSmtpClient } from './mail/smtp.js';
export { parseSystemMailConfig } from './mail/config.js';
export {
  SYSTEM_MAIL_FAILURE_GUIDANCE,
  systemMailFailureCode,
  systemMailFailureInstruction,
} from './mail/system-mail.js';
export type {
  SystemMailFailure,
  SystemMailClient,
  SystemMailConfig,
  SystemMailMessage,
  SystemMailResult,
} from './mail/system-mail.js';
