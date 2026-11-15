import { describe, expect, it } from 'vitest';
import type { WorkflowRunEvent } from '@pertexo/contracts';
import {
  eventStepLabel,
  focusRow,
  graphReadState,
  runStepLabels,
} from '@/features/workflow-runs/model/timeline/run-focus';
import type { RunTimelineRow } from '@/features/workflow-runs/model/timeline/runs';

/* Focused rows: the rules read only a row's key, step, label and status. */
function row(key: string, status: string, nodeId = key): RunTimelineRow {
  return {
    key,
    nodeId,
    label: `Step ${key}`,
    status,
  } as unknown as RunTimelineRow;
}

describe('the step a run page opens first', () => {
  it('prefers what is running, then waiting, unknown, failed, timed out', () => {
    const rows = [
      row('a', 'succeeded'),
      row('b', 'failed'),
      row('c', 'waiting'),
      row('d', 'timed_out'),
    ];
    expect(focusRow(rows)?.key).toBe('c');
    expect(focusRow([...rows, row('e', 'running')])?.key).toBe('e');
    expect(
      focusRow([
        row('a', 'succeeded'),
        row('b', 'outcome_unknown'),
        row('c', 'failed'),
      ])?.key,
    ).toBe('b');
  });

  it('otherwise opens the last step that started, or the first step', () => {
    expect(
      focusRow([
        row('a', 'succeeded'),
        row('b', 'succeeded'),
        row('c', 'not_started'),
      ])?.key,
    ).toBe('b');
    expect(focusRow([row('a', 'not_started')])?.key).toBe('a');
    expect(focusRow([])).toBeUndefined();
  });
});

describe('what an event calls its step', () => {
  const labels = runStepLabels([
    row('fetch#1', 'succeeded', 'fetch'),
    row('fetch#2', 'succeeded', 'fetch'),
  ]);
  const event = (payload: Record<string, unknown>) =>
    ({ payload }) as unknown as WorkflowRunEvent;

  it('names the invocation, else the first row of its step, else its id', () => {
    expect(
      eventStepLabel(
        event({ invocationKey: 'fetch#2', nodeId: 'fetch' }),
        labels,
      ),
    ).toBe('Step fetch#2');
    expect(eventStepLabel(event({ nodeId: 'fetch' }), labels)).toBe(
      'Step fetch#1',
    );
    expect(eventStepLabel(event({ nodeId: 'gone' }), labels)).toBe('gone');
    expect(eventStepLabel(event({}), labels)).toBeUndefined();
  });
});

it('says why the run graph is missing: no access, a failed read, or still loading', () => {
  expect(graphReadState({ canViewWorkflow: false, failed: true })).toBe(
    'forbidden',
  );
  expect(graphReadState({ canViewWorkflow: true, failed: true })).toBe('error');
  expect(graphReadState({ canViewWorkflow: true, failed: false })).toBe(
    'loading',
  );
});
