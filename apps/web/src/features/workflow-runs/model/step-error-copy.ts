// A step's `safeErrorCode` as a sentence (what happened) and advice (what to
// do). The code itself stays visible in mono beside the sentence, so support
// can still find it; prose never shows a bare code.

type StepErrorFix = 'reconnect' | 'review-connection';

export type StepErrorCopy = Readonly<{
  sentence: string;
  advice: string;
  fix?: StepErrorFix;
}>;

const providerUnavailable: StepErrorCopy = {
  sentence:
    'The service this step calls was unavailable, so the step didn’t finish.',
  advice:
    'Pertexo retries on its own while attempts remain. If it keeps failing, replay the run once the service is back.',
};

const providerRateLimited: StepErrorCopy = {
  sentence: 'The service this step calls asked Pertexo to slow down.',
  advice:
    'Pertexo waits and retries. If this keeps happening, spread runs out or raise the service’s limit.',
};

const credentialsRejected: StepErrorCopy = {
  sentence: 'The service rejected the credentials of this step’s connection.',
  advice: 'Test the connection in Connections, fix it, then replay the run.',
  fix: 'review-connection',
};

const outcomeUnknown: StepErrorCopy = {
  sentence:
    'Pertexo lost contact while this step was running, so it can’t tell whether it finished.',
  advice:
    'Check the service this step talks to before replaying, so the action isn’t repeated.',
};

const knownCodes: Readonly<Record<string, StepErrorCopy>> = {
  'provider.unavailable': providerUnavailable,
  'connection.provider_unavailable': providerUnavailable,
  'provider.rate_limited': providerRateLimited,
  'connection.provider_rate_limited': providerRateLimited,
  'connection.reauthorization_required': {
    sentence: 'The connection this step uses needs to be reconnected.',
    advice: 'Reconnect it in Connections, then replay the run.',
    fix: 'reconnect',
  },
  'connection.revoked': {
    sentence: 'The connection this step uses was revoked.',
    advice:
      'Choose another connection for this step in Build, publish, then replay the run.',
  },
  'connection.provider_rejected': credentialsRejected,
  'connection.credential_rejected': credentialsRejected,
  'connection.provider_invalid_response': {
    sentence: 'The service sent back a response Pertexo couldn’t read.',
    advice:
      'Replay the run later. If it keeps happening, check the service’s status page.',
  },
  'run.outcome_unknown': outcomeUnknown,
  'node.outcome_unknown': outcomeUnknown,
  'execution.deadline_exceeded': {
    sentence: 'The run reached its deadline before this step finished.',
    advice:
      'Replay with a later deadline, or raise the workflow’s maximum run duration in Settings.',
  },
  'execution.canceled': {
    sentence: 'The run was stopped before this step finished.',
    advice: 'Replay the run if the work still needs to happen.',
  },
  'artifact.unavailable': {
    sentence: 'A file this step needed wasn’t available.',
    advice: 'Replay the run once the file is available again.',
  },
};

const fallback: StepErrorCopy = {
  sentence: 'This step stopped with an error.',
  advice:
    'The code below tells support exactly what happened. Replay the run if repeating this step is safe.',
};

export function describeStepError(code: string): StepErrorCopy {
  const known = knownCodes[code];
  if (known !== undefined) return known;
  if (code.startsWith('provider.')) return providerUnavailable;
  if (code.startsWith('connection.')) return credentialsRejected;
  return fallback;
}

const SHORT_REASONS: Readonly<Record<string, string>> = {
  'provider.unavailable': 'service unavailable',
  'connection.provider_unavailable': 'service unavailable',
  'provider.rate_limited': 'rate limited by the service',
  'connection.provider_rate_limited': 'rate limited by the service',
  'connection.reauthorization_required': 'connection needs reconnecting',
  'connection.revoked': 'connection revoked',
  'connection.provider_rejected': 'credentials rejected',
  'connection.credential_rejected': 'credentials rejected',
  'connection.provider_invalid_response': 'unreadable response',
  'run.outcome_unknown': 'outcome unknown',
  'node.outcome_unknown': 'outcome unknown',
  'execution.deadline_exceeded': 'deadline reached',
  'execution.canceled': 'stopped',
  'artifact.unavailable': 'file unavailable',
};

/** A few words for a step's error, for one-line summaries such as Home's. */
export function shortStepError(code: string): string {
  const known = SHORT_REASONS[code];
  if (known !== undefined) return known;
  const words = (code.split('.').at(-1) ?? '')
    .replaceAll(/[_-]+/gu, ' ')
    .trim()
    .toLowerCase();
  return /^[a-z ]+$/u.test(words) ? words : 'stopped with an error';
}
