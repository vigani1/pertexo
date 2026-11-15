import { z } from 'zod';

/**
 * The widest node id a trigger row stores (`workflow_triggers.node_id
 * varchar(128)`); every trigger record that names a node reads it.
 */
export const TRIGGER_NODE_ID_MAX_CHARACTERS = 128;

/** The stored input of a run a schedule started: triggers write it, runs read it back. */
export const scheduleRunInputSchema = z
  .object({
    triggerId: z.uuid(),
    nodeId: z.string().trim().min(1).max(TRIGGER_NODE_ID_MAX_CHARACTERS),
    scheduledAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type ScheduleRunInput = z.input<typeof scheduleRunInputSchema>;
