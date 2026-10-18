import { z } from 'zod';

export const workspacePeopleQuerySchema = z
  .object({
    after: z.uuid().optional(),
    q: z.string().trim().max(100).default(''),
  })
  .strict();
export const workspacePeoplePageSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            userId: z.uuid(),
            displayName: z.string().max(256),
            role: z.enum(['owner', 'admin', 'builder', 'operator', 'viewer']),
          })
          .strict(),
      )
      .max(50),
    nextCursor: z.uuid().nullable(),
  })
  .strict();
