export { createEncryptionKeyRepository } from './encryption/keys/keys.repository.js';
export type { EncryptionKeyRepository } from './encryption/keys/keys.repository.js';
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

export {
  AwsKmsEnvelopeKeyProvider,
  ConnectionEnvelopeEncryption,
  connectionSecretAssociatedData,
} from './encryption/envelopes/envelope-encryption.js';
export { ConnectionSecretEncryptionError } from './encryption/encryption.errors.js';

export { createAwsConnectionEnvelopeEncryption } from './encryption/aws-envelope.runtime.js';

export type {
  AwsConnectionEnvelopeEncryptionConfig,
  AwsConnectionEnvelopeEncryptionRuntime,
} from './encryption/aws-envelope.runtime.js';

export type {
  ConnectionSecretContext,
  EnvelopeKeyProvider,
  GeneratedEnvelopeKey,
  KmsClientLike,
  KmsCommand,
  SealedConnectionSecret,
} from './encryption/envelopes/envelope-encryption.js';

export {
  AwsKmsWebhookEnvelopeKeyProvider,
  createAwsWebhookTriggerEnvelopeEncryption,
  createWebhookTriggerEnvelopeEncryption,
  WebhookTriggerEnvelopeEncryption,
  webhookTriggerSecretAssociatedData,
} from './encryption/envelopes/webhook-envelope.js';
export { WebhookTriggerSecretEncryptionError } from './encryption/encryption.errors.js';

export type {
  GeneratedWebhookEnvelopeKey,
  SealedWebhookTriggerSecretEnvelope,
  WebhookEnvelopeKeyProvider,
  WebhookTriggerSecretContext,
} from './encryption/envelopes/webhook-envelope.js';

export {
  createApplicationSecretEnvelope,
  type ApplicationSealedSecret,
  type ApplicationSecretEnvelope,
} from './encryption/envelopes/application-secret-envelope.js';
export { ApplicationSecretKeyUnavailableError } from './encryption/encryption.errors.js';

export { createConnectionEnvelopeEncryption } from './encryption/connection-encryption.runtime.js';
export type { ConnectionEnvelopeEncryptionRuntime } from './encryption/connection-encryption.runtime.js';
export { parseConnectionEncryptionConfig } from './encryption/connection-encryption-config.js';
export type {
  ConnectionEnvelopeEncryptionConfig,
  SelfManagedConnectionEncryptionConfig,
} from './encryption/connection-encryption-config.js';

export {
  applicationKeyVersionSchema,
  validateApplicationKeyRing,
  parseApplicationPreviousKeys,
} from './encryption/keys/key-ring.js';

export type { ApplicationKeyRing } from './encryption/keys/key-ring.js';

export { verifyStoredEncryptionKeys } from './encryption/keys/verify-stored-keys.js';
export { StoredKeyVerificationError } from './encryption/encryption.errors.js';

export {
  createCallbackTokenKeys,
  parseCallbackKeyConfig,
  callbackTokenHash,
  CALLBACK_DEVELOPMENT_KEY,
  type CallbackTokenKeys,
  type CallbackKeyConfig,
  type CallbackTokenIdentity,
} from './callbacks/keys.js';

export { verifyCallbackTokenKeys } from './callbacks/verify.js';

export {
  SECURE_HTTP_ERROR_CODE,
  SecureHttpClient,
  SecureHttpError,
} from './outbound-http/secure.js';

export type {
  SecureHttpAddressPolicy,
  SecureHttpErrorCode,
  SecureHttpFailureObservation,
  SecureHttpFailureStage,
  SecureHttpObserver,
  SecureHttpBodyConsumer,
  SecureHttpRequest,
  SecureHttpResolver,
  SecureHttpResponse,
  SecureHttpStreamingBody,
  SecureHttpTransport,
  SecureHttpTransportRequest,
  SecureHttpTransportResponse,
} from './outbound-http/secure.js';

export {
  createNodeSecureHttpClient,
  NodeDnsResolver,
  NodeHttpTransport,
} from './outbound-http/transport/node.js';

export {
  parseAllowedPrivateNetworks,
  type AllowedPrivateNetwork,
} from './outbound-http/transport/address-policy.js';

export { redactText } from './outbound-http/redaction/redact-text.js';

export { inspectSecureHttpError } from './outbound-http/secure-http.errors.js';
export {
  isAllowedPrivateAddress,
  normalizeUrlHostname,
} from './outbound-http/transport/address-policy.js';

export {
  createSystemMailDeliveryHandler,
  type SystemMailDeliveryHandler,
} from './mail/deliver-system-mail.js';

export { SystemMailConfigurationError } from './mail/mail.errors.js';

export { ApplicationKeyConfigurationError } from './encryption/encryption.errors.js';
