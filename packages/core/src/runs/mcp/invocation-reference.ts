import { z } from 'zod';
import { commandRequestHash } from '../../shared/command-fingerprints.js';

const SAMPLE_RUN_ID = '00000000-0000-4000-8000-000000000000';
const runIdSchema = z.uuid();

export const invocationReferenceSchema = z
  .string()
  .length(invocationReference(SAMPLE_RUN_ID, SAMPLE_RUN_ID).length)
  .regex(/^[A-Za-z0-9_-]+$/u);

export function invocationReference(runId: string, tokenId: string): string {
  return Buffer.from(
    `${runId}.${commandRequestHash({ runId, tokenId })}`,
  ).toString('base64url');
}

export function parseInvocationReference(
  reference: string,
): string | undefined {
  if (!invocationReferenceSchema.safeParse(reference).success) return undefined;
  const decoded = Buffer.from(reference, 'base64url').toString('utf8');
  const runId = runIdSchema.safeParse(decoded.split('.')[0]);
  return runId.success ? runId.data : undefined;
}
