export { verifyWebhookSignature } from './webhooks/verify-signature.js';

export {
  classifySecureHttpResponse,
  type HttpExecutionErrorKind,
  type HttpOutcomeDecision,
  type HttpSideEffectClass,
} from './http/outcome-policy.js';

export {
  createSlackClient,
  SLACK_API_ENDPOINTS,
  type SlackApiResult,
  type SlackChannelLookupResult,
  type SlackClient,
} from './slack/client.js';

export { classifySlackConnectionHealth } from './slack/connection-health.js';

export {
  createResendClient,
  RESEND_API_ENDPOINT,
  type ResendApiResult,
  type ResendClient,
} from './email/client.js';

export {
  createEmailSendNotificationExecutorRegistration,
  type EmailSendNotificationExecutorDependencies,
} from './email/send-notification/send-notification.executor.js';

export { EmailSendNotificationExecutorError } from './email/send-notification/send-notification.errors.js';

export {
  createSlackSendMessageExecutorRegistration,
  type SlackSendMessageExecutorDependencies,
} from './slack/send-message/send-message.executor.js';
export { SlackSendMessageExecutorError } from './slack/send-message/send-message.errors.js';

export {
  createHttpRequestExecutorRegistration,
  type HttpRequestExecutorDependencies,
} from './http/request/request.executor.js';
export { HttpRequestExecutorError } from './http/request/request.errors.js';
export type { ExecutorTelemetry } from './providers/provider-executor.js';

export {
  createOAuth2RenewalClient,
  isOAuth2HostAllowed,
} from './http/request/execution/oauth2-renewal.js';

export {
  newOAuth2Secret,
  newOAuth2State,
  oauth2AuthorizationAddress,
  oauth2Digest,
  oauth2StateWorkspace,
  oauth2VerifierPurpose,
} from './oauth2/consent.js';

export { OAuth2TokenFailure } from './oauth2/oauth2.errors.js';

export {
  refusedEndpoint,
  type OAuth2EndpointPolicy,
} from './oauth2/endpoints.js';

export { decodeClientSettings } from './oauth2/settings.js';

export {
  isTemporaryOAuth2Error,
  requestOAuth2Token,
  type OAuth2TokenAnswer,
} from './oauth2/token-endpoint.js';

export { createResendSystemMailClient } from './email/system-mail.js';

export {
  createProviderHttpClient,
  type ProviderHttpClient,
  type ProviderHttpRequest,
  type ProviderHttpResponse,
  type ProviderHttpBodyConsumer,
  type ProviderHttpStreamingBody,
} from './providers/http-client.js';

export {
  ProviderHttpError,
  type ProviderHttpErrorCode,
} from './providers/http.errors.js';

export { EMAIL_ATTACHMENT_ERROR_CODES } from './email/attachments/attachment.errors.js';

export { HTTP_PAGINATION_FAILURES } from './http/request/pagination/pagination.errors.js';

export { HTTP_OAUTH2_FAILURES } from './http/request/execution/oauth2-renewal.errors.js';

export type { SmtpEmailClient } from './email/smtp.js';
