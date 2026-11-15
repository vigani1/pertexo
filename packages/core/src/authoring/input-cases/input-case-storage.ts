import {
  normalizedJson,
  STORED_INTEGER_MAX,
  utf8ByteLength,
} from '@pertexo/workflow-model';
import { z } from 'zod';

// One below the column's maximum, so the stored revision can still move on.
const revisionSchema = z
  .number()
  .int()
  .positive()
  .max(STORED_INTEGER_MAX - 1);

export const resultSchema = z
  .object({ caseId: z.uuid(), revision: revisionSchema })
  .strict();

export function payload(value: unknown): { text: string; bytes: number } {
  // The case keeps its fields in the order they were written.
  const text = normalizedJson(value);
  return { text, bytes: utf8ByteLength(text) };
}
