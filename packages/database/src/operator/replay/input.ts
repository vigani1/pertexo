import { z } from 'zod';

import { sha256HexSchema } from '../../platform/persisted-primitives.js';

export const inputSchema = z
  .object({
    commandId: z.uuid(),
    delivery: z
      .object({
        outboxEventId: z.uuid(),
        payloadChecksum: sha256HexSchema,
      })
      .strict(),
    signal: z.instanceof(AbortSignal).optional(),
    workspaceId: z.uuid(),
  })
  .strict();

export const payloadSchema = z
  .object({
    commandId: z.uuid(),
    outboxEventId: z.uuid(),
    workspaceId: z.uuid(),
  })
  .strict();
