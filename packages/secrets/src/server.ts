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

export {
  AwsKmsEnvelopeKeyProvider,
  ConnectionEnvelopeEncryption,
  ConnectionSecretEncryptionError,
  connectionSecretAssociatedData,
} from './encryption/envelope-encryption.js';

export { createAwsConnectionEnvelopeEncryption } from './encryption/aws-envelope-runtime.js';

export type {
  AwsConnectionEnvelopeEncryptionConfig,
  AwsConnectionEnvelopeEncryptionRuntime,
} from './encryption/aws-envelope-runtime.js';

export type {
  ConnectionSecretContext,
  EnvelopeKeyProvider,
  GeneratedEnvelopeKey,
  KmsClientLike,
  KmsCommand,
  SealedConnectionSecret,
} from './encryption/envelope-encryption.js';

export {
  AwsKmsWebhookEnvelopeKeyProvider,
  createAwsWebhookTriggerEnvelopeEncryption,
  createWebhookTriggerEnvelopeEncryption,
  WebhookTriggerEnvelopeEncryption,
  WebhookTriggerSecretEncryptionError,
  webhookTriggerSecretAssociatedData,
} from './encryption/webhook-envelope.js';

export type {
  GeneratedWebhookEnvelopeKey,
  SealedWebhookTriggerSecretEnvelope,
  WebhookEnvelopeKeyProvider,
  WebhookTriggerSecretContext,
} from './encryption/webhook-envelope.js';

export {
  createApplicationSecretEnvelope,
  ApplicationSecretKeyUnavailableError,
  type ApplicationSealedSecret,
  type ApplicationSecretEnvelope,
} from './encryption/application-secret-envelope.js';

export {
  createConnectionEnvelopeEncryption,
  parseConnectionEncryptionConfig,
} from './encryption/connection-encryption.runtime.js';

export type {
  ConnectionEnvelopeEncryptionConfig,
  ConnectionEnvelopeEncryptionRuntime,
  SelfManagedConnectionEncryptionConfig,
} from './encryption/connection-encryption.runtime.js';

export {
  applicationKeyVersionSchema,
  validateApplicationKeyRing,
  parseApplicationPreviousKeys,
} from './encryption/key-ring.js';

export type { ApplicationKeyRing } from './encryption/key-ring.js';

export {
  verifyStoredEncryptionKeys,
  StoredKeyVerificationError,
} from './encryption/verify-stored-keys.js';

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

export { redactText } from './outbound-http/redact-text.js';

export { inspectSecureHttpError } from './outbound-http/secure-error.js';
export {
  isAllowedPrivateAddress,
  normalizeUrlHostname,
} from './outbound-http/transport/address-policy.js';

export {
  createSystemMailDeliveryHandler,
  type SystemMailDeliveryHandler,
} from './mail/deliver-system-mail.js';

export { SystemMailConfigurationError } from './mail/config.js';

export { ApplicationKeyConfigurationError } from './encryption/key-ring.js';
