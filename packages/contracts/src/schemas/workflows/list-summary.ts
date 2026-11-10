import { responseSchema } from '../shared/response-schema.js';
import { RUN_STATUSES } from '@pertexo/workflow-model';
import { z } from 'zod';

export const workflowListSummarySchema = responseSchema(
  z
    .object({
      shape: z
        .object({
          nodes: z.array(
            z
              .object({
                id: z.string(),
                definition: z.object({
                  key: z.string(),
                  version: z.number(),
                }),
                position: z.object({ x: z.number(), y: z.number() }),
                label: z.string().optional(),
                structured: z
                  .object({ kind: z.literal('for_each') })
                  .optional(),
              })
              .strict(),
          ),
          edges: z.array(
            z
              .object({
                id: z.string(),
                source: z.object({ nodeId: z.string(), port: z.string() }),
                target: z.object({ nodeId: z.string(), port: z.string() }),
              })
              .strict(),
          ),
        })
        .strict(),
      recentRuns: z
        .array(
          z
            .object({
              status: z.enum(RUN_STATUSES),
              createdAt: z.iso.datetime(),
            })
            .strict(),
        )
        .max(20)
        .optional(),
    })
    .strict(),
);
