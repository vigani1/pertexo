import type { WorkflowTransitionPlan } from '@pertexo/workflow-engine';
import { z } from 'zod';

/** The engine's transition, persisted as decided inside the advance transaction. */
export type RunTransitionPlan = WorkflowTransitionPlan;

export const scheduleRunInputSchema = z
  .object({
    triggerId: z.uuid(),
    nodeId: z.string().trim().min(1).max(128),
    scheduledAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const terminalRunStatuses: ReadonlySet<string> = new Set([
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
  'outcome_unknown',
]);
