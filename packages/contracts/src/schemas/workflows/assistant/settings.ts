import { MODEL_IDENTIFIER_MAX_CHARACTERS } from '@pertexo/node-sdk';
import { z } from 'zod';

const assistantSelectionSchema = z.strictObject({
  connectionId: z.uuid(),
  model: z.string().trim().min(1).max(MODEL_IDENTIFIER_MAX_CHARACTERS),
});

export const assistantSettingsSchema = z.strictObject({
  selection: assistantSelectionSchema.nullable(),
});

export const assistantSettingsResultSchema = z.discriminatedUnion('kind', [
  assistantSettingsSchema.extend({ kind: z.literal('saved') }),
  z.strictObject({ kind: z.literal('connection_unavailable') }),
]);
