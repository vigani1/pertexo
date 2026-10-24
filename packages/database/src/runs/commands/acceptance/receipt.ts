import { z } from 'zod';
import { sha256HexSchema as sha256Schema } from '../../../platform/persisted-primitives.js';

export const resultRefSchema = z
  .object({
    outboxEventId: z.uuid(),
    initialCheckpointHash: sha256Schema.optional(),
  })
  .strict();
