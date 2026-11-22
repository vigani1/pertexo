import { z } from 'zod';

const guardrailsReasonSchema = z.enum([
  'pii.email',
  'pii.phone',
  'pii.payment_card',
  'pii.iban',
  'pii.national_id',
  'terms.prohibited',
  'injection.marker',
]);

export const guardrailsDiagnosticsSchema = z.partialRecord(
  guardrailsReasonSchema,
  z.int().positive(),
);

export type GuardrailsReason = z.output<typeof guardrailsReasonSchema>;
export type GuardrailsDiagnostics = z.output<
  typeof guardrailsDiagnosticsSchema
>;
