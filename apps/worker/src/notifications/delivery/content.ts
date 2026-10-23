import type { FailureNotificationContext } from '@pertexo/workflow-model';

export function render(context: FailureNotificationContext): Readonly<{
  subject: string;
  text: string;
}> {
  const subject = `Workflow run ${context.terminalStatus}`;
  const primaryFailure = context.primaryFailure;
  const text = [
    subject,
    `Run: ${context.runId}`,
    `Workflow: ${context.workflowId}`,
    `Version: ${context.workflowVersionId}`,
    `Trigger: ${context.triggerType}`,
    `Completed: ${context.completedAt}`,
    `Failure: ${primaryFailure.safeErrorCode}`,
    ...('source' in primaryFailure
      ? [`Scope: run (${primaryFailure.runStatus})`]
      : [`Node: ${primaryFailure.nodeId}`]),
    `Failures: ${String(context.totalFailureCount)}`,
  ].join('\n');
  return Object.freeze({ subject, text: text.slice(0, 4_000) });
}
