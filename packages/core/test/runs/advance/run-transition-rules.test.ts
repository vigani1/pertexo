import { describe, expect, it } from 'vitest';
import type { WorkflowTransitionPlan } from '@pertexo/workflow-engine';
import {
  continuesImmediately,
  recordsInboxFailureDay,
  transitionHasHumanWait,
  transitionMoments,
} from '../../../src/runs/advance/persist/run-transition.js';
import type { CoordinatorCommitRow } from '../../../src/runs/advance/load/load-run.js';

const plan = (
  overrides: Readonly<{
    runStatus?: string;
    immediateContinuation?: boolean;
    attempts?: number;
    taskIntents?: number;
    events?: readonly Readonly<{
      name: string;
      occurredAt?: string;
      reasonCode?: string;
    }>[];
  }>,
) =>
  ({
    checkpoint: { runStatus: overrides.runStatus ?? 'running' },
    immediateContinuation: overrides.immediateContinuation,
    attempts: Array.from({ length: overrides.attempts ?? 0 }),
    taskIntents: Array.from({ length: overrides.taskIntents ?? 0 }),
    events: overrides.events ?? [],
  }) as unknown as WorkflowTransitionPlan;

const row = (overrides: Partial<CoordinatorCommitRow> = {}) =>
  ({
    status: 'running',
    trigger_type: 'manual',
    human_wait_started_at: null,
    has_unconsumed_tasks: false,
    has_human_child: false,
    ...overrides,
  }) as CoordinatorCommitRow;

describe('run transition rules', () => {
  it('continues at once only when the engine asks and nothing else will wake the run', () => {
    expect(continuesImmediately(plan({ immediateContinuation: true }))).toBe(
      true,
    );
    expect(continuesImmediately(plan({}))).toBe(false);
    expect(
      continuesImmediately(
        plan({ immediateContinuation: true, runStatus: 'succeeded' }),
      ),
    ).toBe(false);
    expect(
      continuesImmediately(plan({ immediateContinuation: true, attempts: 1 })),
    ).toBe(false);
  });

  it('reads the start, the end and the failure reason from the events', () => {
    expect(
      transitionMoments(
        plan({
          events: [
            { name: 'run.started', occurredAt: '2026-11-15T09:00:00.000Z' },
            {
              name: 'run.timed_out',
              occurredAt: '2026-11-15T10:00:00.000Z',
              reasonCode: 'deadline',
            },
          ],
        }),
      ),
    ).toEqual({
      startedAt: '2026-11-15T09:00:00.000Z',
      completedAt: '2026-11-15T10:00:00.000Z',
      runFailure: 'deadline',
    });
    expect(transitionMoments(plan({}))).toEqual({
      startedAt: undefined,
      completedAt: undefined,
      runFailure: undefined,
    });
  });

  it('keeps the human-wait clock in step when a person is or becomes involved', () => {
    expect(transitionHasHumanWait(row(), plan({}))).toBe(false);
    expect(
      transitionHasHumanWait(
        row({ human_wait_started_at: new Date() }),
        plan({}),
      ),
    ).toBe(true);
    expect(
      transitionHasHumanWait(row({ has_unconsumed_tasks: true }), plan({})),
    ).toBe(true);
    expect(
      transitionHasHumanWait(row({ has_human_child: true }), plan({})),
    ).toBe(true);
    expect(transitionHasHumanWait(row(), plan({ taskIntents: 1 }))).toBe(true);
  });

  it('counts an inbox failure day only for a live run that newly ends unsuccessfully', () => {
    const ended = '2026-11-15T10:00:00.000Z';
    const failed = plan({ runStatus: 'failed' });
    expect(recordsInboxFailureDay(row(), failed, ended)).toBe(true);
    expect(recordsInboxFailureDay(row(), failed, undefined)).toBe(false);
    expect(
      recordsInboxFailureDay(row(), plan({ runStatus: 'succeeded' }), ended),
    ).toBe(false);
    expect(
      recordsInboxFailureDay(row({ status: 'failed' }), failed, ended),
    ).toBe(false);
    expect(
      recordsInboxFailureDay(row({ trigger_type: 'test' }), failed, ended),
    ).toBe(false);
  });
});
