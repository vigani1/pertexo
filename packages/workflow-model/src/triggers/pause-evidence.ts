import { z } from 'zod';
import { pollFailureCodeSchema } from './polling.errors.js';

export const pollPauseEvidenceSchema = z.strictObject({
  kind: z.literal('poll'),
  triggerId: z.uuid(),
  errorCode: pollFailureCodeSchema,
});

export type PollPauseEvidence = z.output<typeof pollPauseEvidenceSchema>;

export const runPauseEvidenceSchema = z.strictObject({
  kind: z.literal('run'),
  runId: z.uuid(),
});

export const triggerPauseEvidenceSchema = z.discriminatedUnion('kind', [
  runPauseEvidenceSchema,
  pollPauseEvidenceSchema,
]);

export type TriggerPauseEvidence = z.output<typeof triggerPauseEvidenceSchema>;
