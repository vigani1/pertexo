import { responseSchema } from '../shared/response-schema.js';
import { CONNECTION_SHARE_LIMIT } from '@pertexo/workflow-model';
import { z } from 'zod';

const sharingMemberId = z.uuid().overwrite((value) => value.toLowerCase());
export const connectionSharingRequestSchema = z
  .object({
    mode: z.enum(['workspace', 'restricted']),
    expectedSharingRevision: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER),
    userIds: z
      .array(sharingMemberId)
      .max(CONNECTION_SHARE_LIMIT)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict()
  .refine(
    (request) => request.mode === 'restricted' || request.userIds.length === 0,
  );
export const connectionSharingResponseSchema = responseSchema(
  z
    .object({
      connectionId: sharingMemberId,
      mode: z.enum(['workspace', 'restricted']),
      revision: z.number().int().positive(),
      members: z
        .array(
          z
            .object({
              userId: sharingMemberId,
              label: z.string(),
              active: z.boolean(),
            })
            .strict(),
        )
        .max(CONNECTION_SHARE_LIMIT),
    })
    .strict(),
);
export const connectionSharingCommandResponseSchema = responseSchema(
  connectionSharingResponseSchema.extend({ replayed: z.boolean() }),
);
export type ConnectionSharingRequest = z.output<
  typeof connectionSharingRequestSchema
>;
export type ConnectionSharing = z.output<
  typeof connectionSharingResponseSchema
>;
