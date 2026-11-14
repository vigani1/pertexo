import { ROLES, ADMINISTRATIVE_ROLES } from '@pertexo/policy';
import { z } from 'zod';
import { inspectJsonValue } from '../../values/json/canonical.js';

// PostgreSQL jsonb text puts a space after every separator, so each member costs this much more.
const JSONB_SEPARATOR_BYTES = 2;

export const PENDING_TASK_LIMITS = Object.freeze({
  titleCharacters: 160,
  configBytes: 16_384,
  detailNameCharacters: 160,
  detailFields: 20,
  detailListItems: 20,
  detailsBytes: 8_192,
  contextBytes: 73_728,
  decidedByNameCharacters: 256,
  instructionsCharacters: 2_000,
  commentCharacters: 2_000,
  audienceMembers: 50,
  defaultExpirySeconds: 604_800,
  minimumExpirySeconds: 3_600,
  maximumExpirySeconds: 2_592_000,
});

export const taskAudienceSchema = z
  .object({
    roles: z
      .array(z.enum(ROLES))
      .max(ROLES.length)
      .default([...ADMINISTRATIVE_ROLES]),
    memberIds: z
      .array(z.uuid())
      .max(PENDING_TASK_LIMITS.audienceMembers)
      .default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.roles.length + value.memberIds.length === 0)
      context.addIssue({
        code: 'custom',
        message: 'Choose at least one role or member.',
      });
    if (
      new Set(value.roles).size !== value.roles.length ||
      new Set(value.memberIds).size !== value.memberIds.length
    )
      context.addIssue({
        code: 'custom',
        message: 'Choose each role or member once.',
      });
  });

export type TaskAudience = z.output<typeof taskAudienceSchema>;

/** The bytes a task value takes in its jsonb column, which every task size limit bounds. */
export function storedTaskBytes(value: unknown): number {
  const { bytes, members } = inspectJsonValue(value);
  return bytes + JSONB_SEPARATOR_BYTES * members;
}

/** `16 KB` for 16,384 bytes: the size people read in a task limit message. */
export function taskKilobytes(bytes: number): string {
  return `${String(bytes / 1_024)} KB`;
}
