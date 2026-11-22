import type {
  ConnectionFormDefinition,
  ConnectionResponse,
  ConnectionTestResponse,
} from '@pertexo/contracts';
import type { StatusTone } from '@/components/ui/status';
import { formatElapsedTime } from '@/lib/format/time';
import { oauth2ShortStatus } from './oauth2-copy';
import { CONNECTION_TEST_TIMEOUT_MILLIS } from '@pertexo/contracts';
import { formatTimeSpan } from '@/lib/format/time';

/** Where a connection test stands, as the test thread draws it. */
export type TestPhase = 'idle' | 'running' | 'ok' | 'failed' | 'unsure';

export type ConnectionStatusWord = Readonly<{
  tone: StatusTone;
  label: 'Unknown' | 'Healthy' | 'Needs reauthorization' | 'Revoked';
}>;

export function describeConnectionStatus(
  status: ConnectionResponse['status'],
  health?: ConnectionResponse['health'],
): ConnectionStatusWord {
  switch (status) {
    case 'active':
      return health?.lastHealthyAt == null
        ? { tone: 'neutral', label: 'Unknown' }
        : { tone: 'success', label: 'Healthy' };
    case 'reauthorization_required':
      return { tone: 'attention', label: 'Needs reauthorization' };
    case 'revoked':
      return { tone: 'canceled', label: 'Revoked' };
  }
}

/** Something broke and someone should know: a connection never signed in to hasn't. */
export function needsReconnecting({
  status,
  health,
}: Pick<ConnectionResponse, 'status' | 'health'>): boolean {
  return (
    status === 'reauthorization_required' &&
    health.lastErrorCode !== 'connection.oauth2_not_authorized'
  );
}

const SMTP_FAILURES: Readonly<Record<string, TestOutcomeCopy>> = {
  'connection.smtp_network': {
    title: 'Cannot connect.',
    detail: 'Check the SMTP host, port and operator network allowlist.',
  },
  'connection.smtp_tls': {
    title: 'TLS failed.',
    detail:
      'Check the security mode, certificate and operator plaintext policy.',
  },
  'connection.smtp_authentication': {
    title: 'Authentication failed.',
    detail: 'Check the username and password.',
  },
  'connection.smtp_sender_rejected': {
    title: 'Sender refused.',
    detail: 'Check the from address and relay sending policy.',
  },
};
const FAILURE_REASONS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    Object.entries(SMTP_FAILURES).map(([code, copy]) => [code, copy.title]),
  ),
  'connection.credential_rejected': 'credential rejected',
  'connection.provider_rate_limited': 'rate limited',
  'connection.provider_unavailable': 'service unavailable',
  'connection.provider_rejected': 'request refused',
  'connection.provider_invalid_response': 'unexpected answer',
  'connection.oauth2_host_not_allowed': 'host not allowed',
  'connection.test.dns_failed': 'address not found',
  'connection.test.ssrf_blocked': 'address not allowed',
  'connection.test.timed_out': 'timed out',
  'connection.test.network_failed': 'network error',
  'connection.test.redirect_rejected': 'unsafe redirect',
  'connection.test.response_too_large': 'answer too large',
  'connection.test.response_encoding_rejected': 'unreadable answer',
  'connection.test.canceled': 'canceled',
};

const REJECTED_CREDENTIAL = {
  signing: 'key unavailable',
  postgres: 'credentials rejected',
  http: 'headers rejected',
} as const;

export function testNouns(definition: ConnectionFormDefinition) {
  const { presentation } = definition;
  return {
    name: presentation.testCopy?.name ?? presentation.name,
    credential: presentation.testCopy?.credential ?? presentation.credential,
  };
}

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
function describeTestFailure(
  definition: ConnectionFormDefinition | undefined,
  errorCode: string,
): string {
  const copy = definition?.presentation.testCopy;
  if (
    definition !== undefined &&
    errorCode === 'connection.credential_rejected'
  ) {
    if (copy?.rejectionReason !== undefined) return copy.rejectionReason;
    if (asksProvider(definition))
      return `invalid ${definition.testInput === 'consent' ? definition.presentation.credential : testNouns(definition).credential}`;
    if (
      definition.test === 'http' ||
      definition.test === 'signing' ||
      definition.test === 'postgres'
    )
      return REJECTED_CREDENTIAL[definition.test];
  }
  return (
    copy?.failureReasons?.[errorCode] ??
    FAILURE_REASONS[errorCode] ??
    unmappedFailure(errorCode)
  );
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
  definition?: ConnectionFormDefinition,
): HealthSentence {
  const { health } = connection;
  if (connection.status === 'revoked')
    return {
      text: `revoked ${formatElapsedTime(connection.updatedAt, now)}`,
      tone: 'quiet',
    };
  const oauth2Status =
    connection.status === 'reauthorization_required'
      ? oauth2ShortStatus(health.lastErrorCode)
      : undefined;
  if (oauth2Status !== undefined)
    return { text: oauth2Status, tone: 'attention' };
  if (health.lastErrorCode !== null)
    return {
      text: `${connection.status === 'reauthorization_required' && health.lastHealthTransitionSource === 'run' ? 'run credential rejected' : 'last test failed'} · ${describeTestFailure(definition, health.lastErrorCode)}`,
      tone: 'attention',
    };
  const newerRunEvidence =
    health.lastRunObservedAt != null &&
    health.lastHealthyAt !== null &&
    (health.lastTestedAt === null ||
      health.lastRunObservedAt > health.lastTestedAt);
  if (newerRunEvidence)
    return {
      text: `healthy run ${formatElapsedTime(health.lastRunObservedAt, now)}`,
      tone: 'quiet',
    };
  if (health.lastTestedAt === null)
    return { text: 'never tested', tone: 'quiet' };
  return {
    text: `tested ${formatElapsedTime(health.lastTestedAt, now)} · OK`,
    tone: 'quiet',
  };
}

export type TestOutcomeCopy = Readonly<{ title: string; detail: string }>;

const SUCCESS_TITLES: Readonly<Partial<Record<string, string>>> = {
  signing: 'The signing key can be opened.',
  postgres: 'PostgreSQL answered the test query.',
  http: 'The API answered.',
  smtp: 'SMTP connection works.',
  oauth2: 'The API answered.',
};

const REJECTED_HELP: Readonly<Partial<Record<string, TestOutcomeCopy>>> = {
  postgres: {
    title: 'PostgreSQL rejected the login.',
    detail: 'Check the user and password.',
  },
  signing: {
    title: 'The signing key is unavailable.',
    detail: 'Replace the key and check the instance encryption settings.',
  },
  http: {
    title: 'The API refused these headers.',
    detail:
      'It answered 401 or 403. Check the header names and values, then replace the credential.',
  },
};

const OAUTH2_REJECTED_HELP: TestOutcomeCopy = {
  title: 'The API refused this token.',
  detail:
    'It answered 401 or 403. Check the scope and that this account can reach that URL, or reconnect.',
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
      return `No answer arrived within ${formatTimeSpan(CONNECTION_TEST_TIMEOUT_MILLIS / 1_000)}.`;
    case 'connection.oauth2_host_not_allowed':
      return 'Call a host this connection allows, or change its allowed hosts.';
    default:
      return 'Check the credential and the service’s settings, then test again.';
  }
}

/** The sentence under the test thread: what happened and what to do next. */
export function describeTestOutcome(
  definition: ConnectionFormDefinition | undefined,
  outcome: ConnectionTestResponse['outcome'],
): TestOutcomeCopy {
  const protocol = definition?.test;
  const usesUrl = definition?.testInput === 'url';
  if (!outcome.ok && protocol === 'smtp') {
    const smtpFailure = SMTP_FAILURES[outcome.errorCode];
    if (smtpFailure !== undefined) return smtpFailure;
  }
  if (outcome.ok)
    return {
      title: testSuccessTitle(definition),
      detail: usesUrl
        ? `It answered ${String(outcome.httpStatus)}, so the ${protocol === 'oauth2' ? 'token works' : 'headers work'}.`
        : 'This connection is ready to use.',
    };
  if (outcome.errorCode === 'connection.credential_rejected') {
    const help = rejectedHelp(definition);
    if (help !== undefined) return help;
  }
  const reason = describeTestFailure(definition, outcome.errorCode);
  return {
    title: `The test failed: ${reason}.`,
    detail: failureDetail(outcome.errorCode),
  };
}

function testSuccessTitle(
  definition: ConnectionFormDefinition | undefined,
): string {
  if (definition === undefined) return 'Connection test passed.';
  if (asksProvider(definition)) {
    const { name, credential } = testNouns(definition);
    return `${name} accepted the ${definition.testInput === 'consent' ? 'test email' : credential}.`;
  }
  return SUCCESS_TITLES[definition.test] ?? 'Connection test passed.';
}

function rejectedHelp(
  definition: ConnectionFormDefinition | undefined,
): TestOutcomeCopy | undefined {
  if (definition === undefined) return undefined;
  if (definition.test === 'oauth2') return OAUTH2_REJECTED_HELP;
  if (asksProvider(definition)) {
    const { name, credential } = testNouns(definition);
    return {
      title: `${name} rejected the ${definition.testInput === 'consent' ? definition.presentation.credential : credential}.`,
      detail:
        definition.presentation.testCopy?.rejectionHelp ??
        'Check the credential and the service’s settings, then test again.',
    };
  }
  return REJECTED_HELP[definition.test];
}

/** A test that asks the provider itself with the saved credential. */
function asksProvider(definition: ConnectionFormDefinition): boolean {
  return (
    definition.test === 'lookup' ||
    (definition.test === 'http' && definition.testInput !== 'url')
  );
}
