import { CODE_INTERRUPTED_COPY } from './error-copy';
import { OAUTH2_SHORT_REASONS } from './oauth2-error-copy';

const SHORT_REASONS: Readonly<Record<string, string>> = {
  'http.response_encoding': 'unsupported or invalid response encoding',
  'http.response_redaction_limit': 'response masking work limit',
  'provider.unavailable': 'service unavailable',
  'connection.provider_unavailable': 'service unavailable',
  'provider.rate_limited': 'rate limited by the service',
  'connection.provider_rate_limited': 'rate limited by the service',
  'connection.reauthorization_required': 'connection needs reconnecting',
  'connection.revoked': 'connection revoked',
  'connection.provider_rejected': 'credentials rejected',
  'connection.credential_rejected': 'credentials rejected',
  'connection.provider_invalid_response': 'unreadable response',
  ...OAUTH2_SHORT_REASONS,
  'run.outcome_unknown': 'outcome unknown',
  'node.outcome_unknown': 'outcome unknown',
  'execution.deadline_exceeded': 'deadline reached',
  'execution.canceled': 'stopped',
  'artifact.unavailable': 'file unavailable',
  'execution.variable_missing': 'a workspace variable is missing',
  'preview.variable_missing': 'a workspace variable is missing',
  'execution.expression_failed': 'an expression failed',
  'preview.expression_failed': 'an expression failed',
  'execution.expression_limit_exceeded': 'an expression went over its limits',
  'preview.expression_limit_exceeded': 'an expression went over its limits',
  'execution.expression_timed_out': 'an expression took too long',
  'execution.expression_unavailable': 'the server was too busy',
  'execution.attempt_invalid': 'an input couldn’t be worked out',
  'preview.input_invalid': 'an input couldn’t be used',
  'preview.config_invalid': 'its setup couldn’t be used',
  'execution.loop_results_too_large': 'loop results too large',
  'execution.provider': 'the service answered with an error',
  'execution.authentication': 'credentials rejected',
  'execution.rate_limit': 'rate limited by the service',
  'execution.network': 'service unreachable',
  'execution.timeout': 'the service didn’t answer in time',
  'execution.configuration': 'its setup couldn’t be used',
  'execution.output_invalid': 'its output couldn’t be kept',
  'email.too_many_attachments': 'too many attachments',
  'email.attachments_too_large': 'attachments too large',
  'code.interrupted': CODE_INTERRUPTED_COPY.summary,
  'code.runtime_error': 'the code threw an error',
  'code.syntax_error': 'the code has a syntax error',
  'code.timeout': 'the code ran too long',
  'code.memory_limit': 'the code used too much memory',
  'code.output_invalid': 'the code returned an unusable value',
  'code.module_refused': 'the code used a module that isn’t allowed',
};

/**
 * A few words for a step's error, for one-line summaries such as Home's.
 * An unknown code never becomes words ("attempt invalid" reads as English
 * but says nothing); it stays a plain "stopped with an error".
 */
export function shortStepError(code: string): string {
  // A step test reports the same failure kinds as preview.<kind>.
  return (
    SHORT_REASONS[code] ??
    SHORT_REASONS[code.replace(/^preview\./u, 'execution.')] ??
    'stopped with an error'
  );
}
