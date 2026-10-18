import { z } from 'zod';
import { COLLABORATION_LIMITS } from './comments.js';
export const workflowPresenceQuerySchema = z
  .object({ tabId: z.uuid() })
  .strict();
export const workflowPresenceHeartbeatSchema = z
  .object({
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    editing: z.boolean(),
    dirty: z.boolean(),
    baseRevision: z.number().int().positive().max(2147483647).nullable(),
  })
  .strict()
  .refine(
    (value) =>
      (!value.dirty || value.editing) &&
      (!value.editing || value.baseRevision !== null),
    'Editing needs a draft revision, and only an editor can have unsaved changes.',
  );
export const workflowPresenceSchema = z
  .object({
    people: z
      .array(
        z
          .object({
            userId: z.uuid(),
            displayName: z.string().max(256),
            editing: z.boolean(),
            dirty: z.boolean(),
            baseRevision: z.number().int().positive().nullable(),
            tabCount: z
              .number()
              .int()
              .positive()
              .max(COLLABORATION_LIMITS.tabs),
          })
          .strict(),
      )
      .max(COLLABORATION_LIMITS.presence),
  })
  .strict();
export const workflowPresenceHeartbeatResultSchema = z
  .object({ accepted: z.boolean() })
  .strict();
export type WorkflowPresenceHeartbeat = z.output<
  typeof workflowPresenceHeartbeatSchema
>;
export type WorkflowPresence = z.output<typeof workflowPresenceSchema>;
