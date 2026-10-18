import { z } from 'zod';
import { workspaceRoleSchema } from './membership.js';
import { isStorageText } from '@pertexo/workflow-model';

export const workspacePeopleQuerySchema = z
  .object({
    after: z.uuid().optional(),
    q: z.string().trim().max(100).refine(isStorageText).default(''),
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
            role: workspaceRoleSchema,
          })
          .strict(),
      )
      .max(50),
    nextCursor: z.uuid().nullable(),
  })
  .strict();

export type WorkspacePeopleQuery = z.output<typeof workspacePeopleQuerySchema>;
export type WorkspacePeoplePage = z.output<typeof workspacePeoplePageSchema>;
