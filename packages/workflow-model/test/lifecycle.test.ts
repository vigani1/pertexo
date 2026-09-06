import { describe, expect, it } from 'vitest';

import {
  planWorkflowLifecycleCommand,
  workflowActivationAfterReconciliation,
  workflowActivationStatusSchema,
  type WorkflowTriggerStatus,
} from '../src/lifecycle.js';

describe('workflow lifecycle command decisions', () => {
  it.each([false, true])(
    'archives published=%s without conflating run cancellation',
    (published) => {
      expect(
        planWorkflowLifecycleCommand({
          command: 'archive',
          lifecycleStatus: 'active',
          activationStatus: 'active',
          hasPublishedVersion: published,
        }),
      ).toEqual({
        changed: true,
        lifecycleStatus: 'archived',
        activationStatus: published ? 'deactivating' : 'inactive',
        reconcileTriggers: published,
      });
    },
  );

  it.each([false, true])(
    'restores published=%s without choosing a new version',
    (published) => {
      expect(
        planWorkflowLifecycleCommand({
          command: 'restore',
          lifecycleStatus: 'archived',
          activationStatus: 'inactive',
          hasPublishedVersion: published,
        }),
      ).toEqual({
        changed: true,
        lifecycleStatus: 'active',
        activationStatus: published ? 'activating' : 'inactive',
        reconcileTriggers: published,
      });
    },
  );

  it('preserves every activation state when the requested lifecycle is already current', () => {
    for (const activationStatus of workflowActivationStatusSchema.options) {
      for (const command of ['archive', 'restore'] as const) {
        const lifecycleStatus = command === 'archive' ? 'archived' : 'active';
        expect(
          planWorkflowLifecycleCommand({
            command,
            lifecycleStatus,
            activationStatus,
            hasPublishedVersion: true,
          }),
        ).toEqual({
          changed: false,
          lifecycleStatus,
          activationStatus,
          reconcileTriggers: false,
        });
      }
    }
  });
});

describe('workflow activation convergence', () => {
  it.each([
    { statuses: [], expected: 'active' },
    { statuses: ['active', 'active'], expected: 'active' },
    { statuses: ['active', 'error'], expected: 'degraded' },
    { statuses: ['active', 'disabled'], expected: 'degraded' },
    { statuses: ['disabled', 'disabled'], expected: 'inactive' },
    {
      statuses: ['desired', 'configuration_required', 'pending'],
      expected: 'activating',
    },
    { statuses: ['error', 'pending'], expected: 'error' },
    { statuses: ['degraded'], expected: 'error' },
  ] satisfies readonly {
    statuses: WorkflowTriggerStatus[];
    expected: string;
  }[])('projects $statuses to $expected', ({ statuses, expected }) => {
    expect(
      workflowActivationAfterReconciliation({
        lifecycleStatus: 'active',
        hasPublishedVersion: true,
        triggerStatuses: statuses,
        failed: false,
      }),
    ).toBe(expected);
  });

  it('keeps unpublication and successful archive inactive, but reports failed deactivation', () => {
    expect(
      workflowActivationAfterReconciliation({
        lifecycleStatus: 'active',
        hasPublishedVersion: false,
        triggerStatuses: [],
        failed: false,
      }),
    ).toBe('inactive');
    expect(
      workflowActivationAfterReconciliation({
        lifecycleStatus: 'archived',
        hasPublishedVersion: true,
        triggerStatuses: ['active'],
        failed: false,
      }),
    ).toBe('inactive');
    expect(
      workflowActivationAfterReconciliation({
        lifecycleStatus: 'archived',
        hasPublishedVersion: true,
        triggerStatuses: ['active'],
        failed: true,
      }),
    ).toBe('error');
  });

  it.each([
    { statuses: ['active', 'pending'], expected: 'degraded' },
    { statuses: ['active'], expected: 'degraded' },
    { statuses: ['pending'], expected: 'error' },
    { statuses: [], expected: 'error' },
  ] satisfies readonly {
    statuses: WorkflowTriggerStatus[];
    expected: string;
  }[])(
    'preserves trusted trigger facts on failure: $statuses',
    ({ statuses, expected }) => {
      const original = [...statuses];
      expect(
        workflowActivationAfterReconciliation({
          lifecycleStatus: 'active',
          hasPublishedVersion: true,
          triggerStatuses: statuses,
          failed: true,
        }),
      ).toBe(expected);
      expect(statuses).toEqual(original);
    },
  );
});
