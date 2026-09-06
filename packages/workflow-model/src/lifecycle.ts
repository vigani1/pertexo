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
