import { redactText } from './redaction/redact-text.js';
import {
  inspectSecureHttpError,
  SecureHttpError,
  type SecureHttpErrorDetails,
} from './secure-http.errors.js';

/**
 * How a provider client built over the secure client reads, rebuilds and
 * redacts the secure client's failures. Applications compose provider clients
 * (secrets stays below integrations) and pass this to integrations'
 * `createProviderHttpClient`, so every app translates failures the same way.
 */
export const SECURE_HTTP_PROVIDER_SECURITY = Object.freeze({
  inspectError: inspectSecureHttpError,
  createError: (
    failure: Pick<
      SecureHttpErrorDetails,
      'code' | 'classification' | 'possiblyDispatched'
    >,
  ): SecureHttpError =>
    new SecureHttpError(failure.code, failure.classification, failure),
  redactText,
});
