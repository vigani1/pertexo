import { z } from 'zod';

/** Stable identity lifecycle, independent of trigger activation health. */
export const workflowLifecycleStatusSchema = z.enum(['active', 'archived']);

/** PostgreSQL-authoritative activation state, shared by server and clients. */
export const workflowActivationStatusSchema = z.enum([
  'inactive',
  'activating',
  'active',
  'deactivating',
  'degraded',
  'error',
]);

export type WorkflowLifecycleStatus = z.output<
  typeof workflowLifecycleStatusSchema
>;
export type WorkflowActivationStatus = z.output<
  typeof workflowActivationStatusSchema
>;

export const workflowTriggerStatusSchema = z.enum([
  'desired',
  'configuration_required',
  'pending',
  'active',
  'degraded',
  'disabled',
  'error',
]);
export type WorkflowTriggerStatus = z.output<
  typeof workflowTriggerStatusSchema
>;

/** Decide desired lifecycle without touching runs or immutable publication. */
export function planWorkflowLifecycleCommand(
  input: Readonly<{
    command: 'archive' | 'restore';
    lifecycleStatus: WorkflowLifecycleStatus;
    activationStatus: WorkflowActivationStatus;
    hasPublishedVersion: boolean;
  }>,
): Readonly<{
  changed: boolean;
  lifecycleStatus: WorkflowLifecycleStatus;
  activationStatus: WorkflowActivationStatus;
  reconcileTriggers: boolean;
}> {
  const lifecycleStatus = input.command === 'archive' ? 'archived' : 'active';
  if (lifecycleStatus === input.lifecycleStatus)
    return Object.freeze({
      changed: false,
      lifecycleStatus,
      activationStatus: input.activationStatus,
      reconcileTriggers: false,
    });
  return Object.freeze({
    changed: true,
    lifecycleStatus,
    activationStatus: !input.hasPublishedVersion
      ? 'inactive'
      : input.command === 'archive'
        ? 'deactivating'
        : 'activating',
    reconcileTriggers: input.hasPublishedVersion,
  });
}

/** Aggregate only authoritative current-version trigger facts. */
export function workflowActivationAfterReconciliation(
  input: Readonly<{
    lifecycleStatus: WorkflowLifecycleStatus;
    hasPublishedVersion: boolean;
    triggerStatuses: readonly WorkflowTriggerStatus[];
    failed: boolean;
  }>,
): WorkflowActivationStatus {
  if (!input.hasPublishedVersion) return 'inactive';
  const usable = input.triggerStatuses.filter((status) => status === 'active');
  if (input.failed)
    return input.lifecycleStatus === 'active' && usable.length > 0
      ? 'degraded'
      : 'error';
  if (input.lifecycleStatus === 'archived') return 'inactive';
  if (usable.length === input.triggerStatuses.length) return 'active';
  if (usable.length > 0) return 'degraded';
  if (input.triggerStatuses.every((status) => status === 'disabled'))
    return 'inactive';
  if (
    input.triggerStatuses.some(
      (status) => status === 'error' || status === 'degraded',
    )
  )
    return 'error';
  return 'activating';
}
