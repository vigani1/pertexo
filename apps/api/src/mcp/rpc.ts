import { z } from 'zod';

const INVOCATION_REFERENCE_CHARACTERS = 135;
const referenceSchema = z
  .string()
  .length(INVOCATION_REFERENCE_CHARACTERS)
  .regex(/^[A-Za-z0-9_-]+$/u);
export const statusArguments = z
  .object({ invocation: referenceSchema })
  .strict();
export const statusToolInput = z.toJSONSchema(statusArguments);

export function invocationRunId(reference: string) {
  const decoded = Buffer.from(reference, 'base64url').toString('utf8');
  const runId = z.uuid().safeParse(decoded.split('.')[0]);
  return runId.success ? runId.data : undefined;
}
