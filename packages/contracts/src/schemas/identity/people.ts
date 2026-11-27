import { responseSchema } from '../shared/response-schema.js';
import { z } from 'zod';
import { workspaceRoleSchema } from './membership.js';
import {
  isStorageText,
  DISPLAY_NAME_MAX_CHARACTERS,
} from '@pertexo/workflow-model';

const PEOPLE_BOUNDS = Object.freeze({
  qCharacters: 100,
  displayNameCharacters: DISPLAY_NAME_MAX_CHARACTERS,
  workspacePeoplePageItems: 50,
});

export const workspacePeopleQuerySchema = z
  .object({
    after: z.uuid().optional(),
    q: z
      .string()
      .trim()
      .max(PEOPLE_BOUNDS.qCharacters)
      .refine(isStorageText)
      .default(''),
  })
  .strict();
export const workspacePeoplePageSchema = responseSchema(
  z
    .object({
      items: z
        .array(
          z
            .object({
              userId: z.uuid(),
              displayName: z.string().max(PEOPLE_BOUNDS.displayNameCharacters),
              role: workspaceRoleSchema,
            })
            .strict(),
        )
        .max(PEOPLE_BOUNDS.workspacePeoplePageItems),
      nextCursor: z.uuid().nullable(),
    })
    .strict(),
);

export type WorkspacePeopleQuery = z.output<typeof workspacePeopleQuerySchema>;
export type WorkspacePeoplePage = z.output<typeof workspacePeoplePageSchema>;

/** A person by id and current display name, such as who published a version. */
export const personReferenceSchema = z
  .object({
    id: z.uuid(),
    displayName: z.string().max(PEOPLE_BOUNDS.displayNameCharacters),
  })
  .strict();
