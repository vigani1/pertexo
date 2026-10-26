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
  'execution.table_unavailable': {
    sentence: 'Data table storage was temporarily unavailable.',
    advice:
      'Pertexo retries using the same write receipt, so an accepted write is not repeated.',
  },
  'execution.table_not_found': {
    sentence: 'The workspace data table is unavailable.',
    advice:
      'Choose an existing table in this step\u2019s setup, then publish and start again.',
  },
  'execution.table_invalid_values': {
    sentence: 'The row values or query do not match the table schema.',
    advice:
      'Check required columns, cell types and filter values. Rows fit up to 64 KB.',
  },
  'execution.table_quota_exceeded': {
    sentence: 'The table\u2019s row or workspace storage limit was reached.',
    advice:
      'Remove unneeded rows, split the data or ask an admin to raise the table limits.',
  },
  'execution.table_key_conflict': {
    sentence: 'Another row already uses this unique key.',
    advice:
      'Use Upsert by key to update an existing row, or choose a different key.',
  },
  'execution.table_conflict': {
    sentence: 'The retried table command changed.',
    advice: 'Check the current table and mappings before starting a new run.',
  },
  'execution.table_result_too_large': {
    sentence: 'Too much table data matched this query.',
    advice:
      'Narrow the filters or lower the row limit to fit the execution value bounds.',
  },
  'execution.table_unsafe_filter': {
    sentence: 'This table write needs a filter.',
    advice:
      'Choose at least one filter. At most 1,000 rows can be changed in one step.',
  },
  'execution.table_attempt_expired': {
    sentence: 'This table attempt is no longer current.',
    advice: 'Check the run\u2019s cancellation, deadline or workspace status.',
  },

  'pending_task.expired': {
    sentence: 'This task expired before anyone answered it.',
    advice:
      'Check who can answer it and how long it waits. Replay to open a new task; a failure route can handle expiry.',
  },
  'pending_task.capacity_exceeded': {
    sentence: 'This workspace has reached its pending-task allowance.',
    advice:
      'Finish or cancel other pending tasks, then replay this run. The queued-run allowance also bounds pending tasks.',
  },
  'execution.file_input': {
    sentence: 'This step could not read the file.',
    advice:
      'Correct the file or reference, then start a new run. Files fit up to 1 MB; split larger files into smaller files for separate runs.',
  },
  'email.too_many_attachments': {
    sentence: 'This email had more files attached than it can carry.',
    advice:
      'Attach at most 10 files, or split them across several emails, then start a new run.',
  },
  'email.attachments_too_large': {
    sentence: 'The attached files were too large to send together.',
    advice:
      'Keep the files within 6 MB in total, or split them across several emails, then start a new run.',
  },
  call_target_unavailable: {
    sentence: 'The child workflow could not accept this Call.',
    advice: 'Check that the child is active, then replay the parent.',
  },
  call_target_capacity_exceeded: {
    sentence:
      'The child workflow’s concurrency or ordering policy refused this Call.',
    advice:
      'Wait for the child workflow’s other runs to finish, then replay the parent.',
  },
  call_target_not_callable: {
    sentence: 'The pinned child version has no callable contract.',
    advice:
      'Choose a published callable version in Build, then publish and replay the parent.',
  },
  call_input_invalid: {
    sentence: 'The mapped input does not match the child’s contract.',
    advice:
      'Review this Call’s input mappings and the pinned child contract, then publish and replay.',
  },
  call_input_too_large: {
    sentence: 'The mapped input exceeds the Call’s inline value limit.',
    advice:
      'Reduce the mapped input to fit 256 KiB including its storage wrapper, then publish and replay.',
  },
  call_input_artifact_unsupported: {
    sentence: 'This Call cannot pass a file into another run.',
    advice:
      'Map bounded inline JSON matching the child’s contract, then publish and replay.',
  },
  call_deadline_expired: {
    sentence:
      'The Call reached its recorded deadline before the child started.',
    advice: 'Review the parent and child deadlines before replaying.',
  },
  call_parent_closed: {
    sentence: 'The parent ended before this Call could start.',
    advice: 'Review the parent’s history before replaying.',
  },
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
  'execution.variable_missing': {
    sentence:
      'A workspace variable used by this step is missing from the captured set.',
    advice:
      'Add the variable or update the mapping, then start a new run. Replay and recovery keep the original values.',
  },
  'preview.variable_missing': {
    sentence: 'A workspace variable used by this preview is missing.',
    advice: 'Add it in Variables, then start a new preview.',
  },
  'execution.attempt_invalid': {
    sentence:
      'One of this step’s inputs couldn’t be worked out, so the step didn’t run.',
    advice:
      'Check its inputs in Build (an expression that fails, or a path that isn’t in the data), publish, then replay the run.',
  },
  'execution.loop_results_too_large': {
    sentence:
      'The For each results feeding this step were too large to pass on.',
    advice:
      'Return less from the loop’s last step, such as only the fields later steps use, then replay the run.',
  },
  'artifact.unavailable': {
    sentence: 'A file this step needed wasn’t available.',
    advice: 'Replay the run once the file is available again.',
  },
  // What a step's own executor reports, by kind of failure.
  'execution.provider': {
    sentence: 'The service this step calls answered with an error.',
    advice:
      'Check what the step sent under Input & output, fix it in Build if needed, then replay. HTTP Request can return error answers to the workflow instead: turn on Return error responses.',
  },
  'execution.authentication': credentialsRejected,
  'execution.rate_limit': providerRateLimited,
  'execution.network': {
    sentence: 'This step couldn’t reach the service it calls.',
    advice:
      'Check the address and that the service is up, then replay the run.',
  },
  'execution.timeout': {
    sentence: 'The service this step calls didn’t answer in time.',
    advice:
      'Replay the run later, or raise the step’s timeout in Build if the service is slow.',
  },
  'execution.configuration': {
    sentence: 'This step’s setup couldn’t be used.',
    advice: 'Check its settings in Build, publish, then replay the run.',
  },
  'execution.internal': {
    sentence: 'Something went wrong inside this step.',
    advice:
      'Replay the run. If it keeps happening, send support the code below.',
  },
  'execution.output_invalid': {
    sentence: 'This step returned a value Pertexo couldn’t keep.',
    advice:
      'Return a smaller or simpler value from the step, publish, then replay the run.',
  },
  'code.runtime_error': {
    sentence: 'The code threw an error.',
    advice:
      'Read the error and logs below, fix the code in Build, publish, then replay the run.',
  },
  'code.syntax_error': {
    sentence: 'The code has a syntax error, so it didn’t run.',
    advice: 'Fix it in Build, publish, then replay the run.',
  },
  'code.timeout': {
    sentence: 'The code ran past its time limit.',
    advice:
      'Make it do less per run or raise its time limit in Build, then replay.',
  },
  'code.memory_limit': {
    sentence: 'The code used more memory than it’s allowed.',
    advice: 'Process less data at once, publish, then replay the run.',
  },
  'code.output_invalid': {
    sentence: 'The code returned a value Pertexo can’t pass on.',
    advice:
      'Return plain JSON: no undefined, dates, functions or very large values. Then replay.',
  },
  'code.module_refused': {
    sentence: 'The code imported a module that isn’t allowed.',
    advice: 'Use only the modules the Code step offers, then replay the run.',
  },
};

const fallback: StepErrorCopy = {
  sentence: 'This step stopped with an error.',
  advice:
    'The code below tells support exactly what happened. Replay the run if repeating this step is safe.',
};

/** An expiry reads differently for an approval, a form and a callback. */
const EXPIRED_BY_STEP: Readonly<Record<string, StepErrorCopy>> = {
  'core.approval': {
    sentence: 'Nobody approved or rejected this before it expired.',
    advice:
      'Check who can approve it and how long it waits. Replay to ask again; a failure route can handle expiry.',
  },
  'core.request_input': {
    sentence: 'Nobody filled in this form before it expired.',
    advice:
      'Check who can fill it in and how long it waits. Replay to ask again; a failure route can handle expiry.',
  },
  'core.wait': {
    sentence: 'The other service didn’t call back in time.',
    advice:
      'Check that it received this step’s URL and how long the step waits. Replay to wait again; a failure route can handle a timeout.',
  },
};

export function describeStepError(
  code: string,
  definitionKey?: string,
): StepErrorCopy {
  if (code === 'pending_task.expired' && definitionKey !== undefined) {
    const expired = EXPIRED_BY_STEP[definitionKey];
    if (expired !== undefined) return expired;
  }
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
  'execution.variable_missing': 'a workspace variable is missing',
  'preview.variable_missing': 'a workspace variable is missing',
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
