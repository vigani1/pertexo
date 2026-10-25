import { normalizedJson, utf8ByteLength } from '@pertexo/workflow-model';
import { z } from 'zod';

const revisionSchema = z.number().int().positive().max(2_147_483_646);

export const resultSchema = z
  .object({ caseId: z.uuid(), revision: revisionSchema })
  .strict();

export function payload(value: unknown): { text: string; bytes: number } {
  // The case keeps its fields in the order they were written.
  const text = normalizedJson(value);
  return { text, bytes: utf8ByteLength(text) };
}
