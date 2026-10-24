import { z } from 'zod';
import { sha256HexSchema } from '../../platform/persisted-primitives.js';

export const coordinatorIdentitySchema = z.uuid();

export const coordinatorDeliverySchema = z
  .object({
    outboxEventId: z.uuid(),
    payloadChecksum: sha256HexSchema,
  })
  .strict();
