import { invocationReferenceSchema } from '@pertexo/core/runs';
import { z } from 'zod';

export const statusArguments = z.strictObject({ invocation: z.string() });
export const statusToolInput = z.toJSONSchema(
  statusArguments.extend({ invocation: invocationReferenceSchema }),
);
