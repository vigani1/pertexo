import type { WorkflowRunEvent } from '@pertexo/contracts';
import type { RunTimelineRow } from './runs';

// Which step a run's page opens first and what each event calls its step.

/** The step worth opening first: what's running, waiting or went wrong. */
export function focusRow(
  rows: readonly RunTimelineRow[],
): RunTimelineRow | undefined {
  const order = [
    'running',
    'waiting',
    'outcome_unknown',
    'failed',
    'timed_out',
  ];
  const firstByStatus = new Map<string, RunTimelineRow>();
  for (const row of rows)
    if (!firstByStatus.has(row.status)) firstByStatus.set(row.status, row);
  for (const status of order) {
    const row = firstByStatus.get(status);
    if (row !== undefined) return row;
  }
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row === undefined || row.status === 'not_started') continue;
    const parentKey = row.agentWork?.parentInvocationKey;
    return parentKey === undefined
      ? row
      : (rows.find(({ key }) => key === parentKey) ?? row);
  }
  return rows[0];
}

/** Each row's label by its key, and the first row's label for each step. */
export function runStepLabels(
  rows: readonly RunTimelineRow[],
): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  for (const row of rows) {
    labels.set(row.key, row.label);
    if (!labels.has(`node:${row.nodeId}`))
      labels.set(`node:${row.nodeId}`, row.label);
  }
  return labels;
}

/** The step an event names: its invocation's row, else its step's, else its id. */
export function eventStepLabel(
  event: WorkflowRunEvent,
  labels: ReadonlyMap<string, string>,
): string | undefined {
  const { invocationKey, nodeId } = event.payload;
  return (
    (invocationKey === undefined ? undefined : labels.get(invocationKey)) ??
    (nodeId === undefined ? undefined : labels.get(`node:${nodeId}`)) ??
    nodeId
  );
}

/** What the run graph tab shows while it has no graph. */
export function graphReadState(
  input: Readonly<{ canViewWorkflow: boolean; failed: boolean }>,
) {
  if (!input.canViewWorkflow) return 'forbidden';
  if (input.failed) return 'error';
  return 'loading';
}
