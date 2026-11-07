import type { FailureNotificationContext } from '@pertexo/workflow-model';

export function render(
  context: FailureNotificationContext,
  presentation: Readonly<{
    workflowName: string;
    runUrl: string;
    kind: 'slack' | 'email';
  }>,
): Readonly<{ subject: string; text: string }> {
  const name = presentation.workflowName
    .replaceAll(/\p{Cc}/gu, ' ')
    .slice(0, 200);
  const failure = context.primaryFailure;
  const description = failureDescription(context);
  const subject = `${name}: run ${description.outcome}`;
  const text = [
    subject,
    description.advice,
    `Open the run: ${presentation.runUrl}`,
    '',
    'Details for support:',
    `Run: ${context.runId}`,
    `Workflow: ${context.workflowId}`,
    `Version: ${context.workflowVersionId}`,
    `Completed: ${context.completedAt}`,
    `Failure: ${failure.safeErrorCode}`,
    ...('source' in failure
      ? [`Scope: run (${failure.runStatus})`]
      : [`Node: ${failure.nodeId}`]),
    `Failures: ${String(context.totalFailureCount)}`,
  ].join('\n');
  return Object.freeze({
    subject,
    text: (presentation.kind === 'slack' ? slackText(text) : text).slice(
      0,
      4000,
    ),
  });
}

function failureDescription(
  context: FailureNotificationContext,
): Readonly<{ outcome: string; advice: string }> {
  const failure = context.primaryFailure;
  if (
    context.terminalStatus === 'outcome_unknown' ||
    ('nodeStatus' in failure && failure.nodeStatus === 'outcome_unknown')
  )
    return {
      outcome: 'needs review',
      advice:
        'Pertexo could not confirm whether the action completed. Check the outside service before replaying this run to avoid doing the action twice.',
    };
  if (
    context.terminalStatus === 'timed_out' ||
    ('nodeStatus' in failure && failure.nodeStatus === 'timed_out') ||
    failure.safeErrorCode === 'code.timeout'
  )
    return {
      outcome: 'timed out',
      advice:
        'A step or the run exceeded its time limit. Open the run, reduce the work or adjust its allowed timeout, then try again.',
    };
  return {
    outcome: 'failed',
    advice:
      'A step failed and the run could not finish. Review the failed step in the run, fix its settings or connection, then try again.',
  };
}

function slackText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
