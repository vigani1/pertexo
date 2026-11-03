export { verifyWebhookSignature } from './webhooks/verify-signature.js';

export {
  SECURE_HTTP_ERROR_CODE,
  SecureHttpClient,
  SecureHttpError,
} from './http/secure.js';
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
} from './http/secure.js';
export {
  createNodeSecureHttpClient,
  NodeDnsResolver,
  NodeHttpTransport,
} from './http/transport/node.js';
export {
  parseAllowedPrivateNetworks,
  type AllowedPrivateNetwork,
} from './http/transport/address-policy.js';
export {
  classifySecureHttpError,
  classifySecureHttpResponse,
  HTTP_SIDE_EFFECT_CLASS,
} from './http/outcome-policy.js';
export { createSlackClient, SLACK_API_ENDPOINTS } from './slack/client.js';
export { classifySlackConnectionHealth } from './slack/connection-health.js';
export type {
  SlackApiResult,
  SlackChannelLookupResult,
  SlackClient,
} from './slack/client.js';
export { createResendClient, RESEND_API_ENDPOINT } from './email/client.js';
export type { ResendApiResult, ResendClient } from './email/client.js';

export { createEmailSendNotificationExecutorRegistration } from './email/email-send-notification.executor.js';
export { EmailSendNotificationExecutorError } from './email/failure.js';
export type {
  EmailSendNotificationExecutorDependencies,
  EmailSendNotificationExecutorTelemetry,
} from './email/email-send-notification.executor.js';
export {
  createSlackSendMessageExecutorRegistration,
  SlackSendMessageExecutorError,
} from './slack/slack-send-message.executor.js';
export type {
  SlackSendMessageExecutorDependencies,
  SlackSendMessageExecutorTelemetry,
} from './slack/slack-send-message.executor.js';
export {
  createHttpRequestExecutorRegistration,
  HttpRequestExecutorError,
  NOOP_HTTP_REQUEST_EXECUTOR_TELEMETRY,
} from './http-request/http-request.executor.js';
export type {
  HttpRequestExecutorDependencies,
  HttpRequestExecutorTelemetry,
} from './http-request/http-request.executor.js';
export {
  createOAuth2RenewalClient,
  isOAuth2HostAllowed,
} from './http-request/execution/oauth2-renewal.js';

export {
  newOAuth2Secret,
  newOAuth2State,
  oauth2AuthorizationAddress,
  oauth2Digest,
  oauth2StateWorkspace,
  oauth2VerifierPurpose,
} from './oauth2/consent.js';
export { OAuth2TokenFailure } from './oauth2/oauth2-token.js';

export { refusedEndpoint } from './oauth2/endpoints.js';
export type { OAuth2EndpointPolicy } from './oauth2/endpoints.js';
export { decodeClientSettings } from './oauth2/settings.js';

export {
  isTemporaryOAuth2Error,
  requestOAuth2Token,
} from './oauth2/token-endpoint.js';
export type { OAuth2TokenAnswer } from './oauth2/token-endpoint.js';
export type {
  HttpExecutionErrorKind,
  HttpOutcomeDecision,
  HttpSideEffectClass,
} from './http/outcome-policy.js';

export { createResendSystemMailClient } from './email/system-mail.js';

export { HttpPaginationFailure } from './http-request/pagination/failure.js';

export { redactText } from './security/redact-text.js';
