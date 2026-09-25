import type {
  ConnectionResponse,
  ConnectionTestResponse,
} from '@pertexo/contracts/schemas/connections';
import type { StatusTone } from '@/components/ui/status';
import { formatRelativeTime } from '@/lib/format-time';
import type { ProviderKey } from './connection-providers';

/** Where a connection test stands, as the test thread draws it. */
export type TestPhase = 'idle' | 'running' | 'ok' | 'failed' | 'unsure';

export type ConnectionStatusWord = Readonly<{
  tone: StatusTone;
  label: 'Active' | 'Reconnect' | 'Revoked';
}>;

export function describeConnectionStatus(
  status: ConnectionResponse['status'],
): ConnectionStatusWord {
  switch (status) {
    case 'active':
      return { tone: 'success', label: 'Active' };
    case 'reauthorization_required':
      return { tone: 'attention', label: 'Reconnect' };
    case 'revoked':
      return { tone: 'canceled', label: 'Revoked' };
  }
}

const FAILURE_REASONS: Readonly<Record<string, string>> = {
  'connection.credential_rejected': 'credential rejected',
  'connection.provider_rate_limited': 'rate limited',
  'connection.provider_unavailable': 'service unavailable',
  'connection.provider_rejected': 'request refused',
  'connection.provider_invalid_response': 'unexpected answer',
  'connection.test.dns_failed': 'address not found',
  'connection.test.ssrf_blocked': 'address not allowed',
  'connection.test.timed_out': 'timed out',
  'connection.test.network_failed': 'network error',
  'connection.test.redirect_rejected': 'unsafe redirect',
  'connection.test.response_too_large': 'answer too large',
  'connection.test.response_encoding_rejected': 'unreadable answer',
  'connection.test.canceled': 'canceled',
};

const REJECTED_CREDENTIAL: Readonly<Record<ProviderKey, string>> = {
  slack: 'invalid token',
  http: 'headers rejected',
  email: 'invalid API key',
};

/**
 * A code Pertexo doesn't know yet, in words: its last part without
 * separators ("http.request_failed" → "request failed"), never the raw code.
 */
function unmappedFailure(errorCode: string): string {
  const words = (errorCode.split('.').at(-1) ?? '')
    .replaceAll(/[_-]+/gu, ' ')
    .trim()
    .toLowerCase();
  return /^[a-z ]+$/u.test(words) ? words : 'the service reported a problem';
}

/** A few words for why the last test failed, never the raw code. */
function describeTestFailure(provider: ProviderKey, errorCode: string): string {
  if (errorCode === 'connection.credential_rejected')
    return REJECTED_CREDENTIAL[provider];
  return FAILURE_REASONS[errorCode] ?? unmappedFailure(errorCode);
}

export type HealthSentence = Readonly<{
  text: string;
  tone: 'quiet' | 'attention';
}>;

/** "tested 2 hr ago · OK", "last test failed · invalid token", "never tested". */
export function describeConnectionHealth(
  connection: Pick<
    ConnectionResponse,
    'providerKey' | 'status' | 'health' | 'updatedAt'
  >,
  now = Date.now(),
): HealthSentence {
  const { health } = connection;
  if (connection.status === 'revoked')
    return {
      text: `revoked ${formatRelativeTime(connection.updatedAt, now)}`,
      tone: 'quiet',
    };
  if (health.lastErrorCode !== null)
    return {
      text: `last test failed · ${describeTestFailure(connection.providerKey, health.lastErrorCode)}`,
      tone: 'attention',
    };
  if (health.lastTestedAt === null)
    return { text: 'never tested', tone: 'quiet' };
  return {
    text: `tested ${formatRelativeTime(health.lastTestedAt, now)} · OK`,
    tone: 'quiet',
  };
}

export type TestOutcomeCopy = Readonly<{ title: string; detail: string }>;

const SUCCESS_TITLES: Readonly<Record<ProviderKey, string>> = {
  slack: 'Slack accepted the token.',
  http: 'The API answered.',
  email: 'Resend accepted the test email.',
};

const REJECTED_HELP: Readonly<Record<ProviderKey, TestOutcomeCopy>> = {
  slack: {
    title: 'Slack rejected the token.',
    detail:
      'Copy the Bot User OAuth Token again and check the app is still installed in your workspace.',
  },
  http: {
    title: 'The API refused these headers.',
    detail:
      'It answered 401 or 403. Check the header names and values, then replace the credential.',
  },
  email: {
    title: 'Resend rejected the API key.',
    detail:
      'Create a new sending key in Resend and check the from address uses a verified domain.',
  },
};

function failureDetail(errorCode: string): string {
  switch (errorCode) {
    case 'connection.provider_rate_limited':
      return 'The service asked Pertexo to slow down. Wait a minute and test again.';
    case 'connection.provider_unavailable':
      return 'The service is having trouble right now. Test again in a few minutes.';
    case 'connection.test.dns_failed':
      return 'That address doesn’t resolve. Check the URL for typos.';
    case 'connection.test.ssrf_blocked':
      return 'Pertexo only calls public HTTPS addresses, not private or local ones.';
    case 'connection.test.timed_out':
      return 'No answer arrived within 15 seconds.';
    default:
      return 'Check the credential and the service’s settings, then test again.';
  }
}

/** The sentence under the test thread: what happened and what to do next. */
export function describeTestOutcome(
  provider: ProviderKey,
  outcome: ConnectionTestResponse['outcome'],
): TestOutcomeCopy {
  if (outcome.ok)
    return {
      title: SUCCESS_TITLES[provider],
      detail:
        provider === 'http'
          ? `It answered ${String(outcome.httpStatus)}, so the headers work.`
          : 'This connection is ready to use.',
    };
  if (outcome.errorCode === 'connection.credential_rejected')
    return REJECTED_HELP[provider];
  const reason = describeTestFailure(provider, outcome.errorCode);
  return {
    title: `The test failed: ${reason}.`,
    detail: failureDetail(outcome.errorCode),
  };
}
